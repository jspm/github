var fs = require('graceful-fs');
var path = require('path');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var request = require('request');
var expandTilde = require('expand-tilde');

var Promise = require('bluebird');
var asp = require('bluebird').Promise.promisify;

var tar = require('tar-fs');
var zlib = require('zlib');

var semver = require('semver');

function extend(dest, src) {
  for (var key in src) {
    if(key in dest && typeof dest[key] === 'object') extend(dest[key], src[key]);
    else dest[key] = src[key]
  }

  return dest;
}

try {
  var netrc = require('netrc')();
}
catch(e) {}

var lsRemote = asp(require('./ls-remote'));

function createRemoteStrings(auth, hostname) {
  var authString = auth.username ? (encodeURIComponent(auth.username) + ':' + encodeURIComponent(auth.password) + '@') : '';
  hostname = hostname || 'github.com';

  this.remoteString = 'https://' + authString + hostname + '/';
  this.authSuffix = auth.token ? '?access_token=' + auth.token : '';

  if (hostname == 'github.com')
    this.apiRemoteString = 'https://' + authString + 'api.github.com/';

  // Github Enterprise
  else
    this.apiRemoteString = 'https://' + authString + hostname + '/api/v3/';
}

function decodeCredentials(str) {
  var auth = new Buffer(str, 'base64').toString('utf8').split(':');

  var username, password;

  try {
    username = decodeURIComponent(auth[0]);
    password = decodeURIComponent(auth[1]);
  }
  catch(e) {
    username = auth[0];
    password = auth[1];
  }

  return {
    username: username,
    password: password
  };
}

function readNetrc(hostname) {
  hostname = hostname || 'github.com';
  var creds = netrc[hostname];

  if (creds) {
    return {
      username: creds.login,
      password: creds.password
    };
  }
}

function isGithubToken(token) {
  return token.match(/[0-9a-f]{40}/);
}

var GithubLocation = function(options, ui) {
  this.name = options.name;

  this.max_repo_size = (options.maxRepoSize || 0) * 1024 * 1024;

  this.versionString = options.versionString + '.1';

  // Give the environment precedence over options object
  var auth = process.env.JSPM_GITHUB_AUTH_TOKEN || options.auth;

  if (auth) {
    if (isGithubToken(auth)) {
      this.auth = { token: auth };
    } else {
      this.auth = decodeCredentials(auth);
    }
  } else {
    this.auth = readNetrc(options.hostname);
  }

  this.ui = ui;

  this.defaultRequestOptions = {
    headers: {
      'User-Agent': 'jspm'
    },
    strictSSL: 'strictSSL' in options ? options.strictSSL : true
  };

  var self = this, envMap = {
    ca: 'GIT_SSL_CAINFO',
    cert: 'GIT_SSL_CERT',
    key: 'GIT_SSL_KEY'
  };

  ['ca', 'cert', 'key'].forEach(function(key) {
    if (key in options) {
      var path = expandTilde(options[key]);
      self.defaultRequestOptions[key] = fs.readFileSync(path, 'ascii');
    }
  });

  this.remote = options.remote;

  createRemoteStrings.call(this, this.auth || {}, options.hostname);
};

function clearDir(dir) {
  return new Promise(function(resolve, reject) {
    fs.exists(dir, function(exists) {
      resolve(exists);
    });
  })
  .then(function(exists) {
    if (exists)
      return asp(rimraf)(dir);
  });
}

function prepDir(dir) {
  return clearDir(dir)
  .then(function() {
    return asp(mkdirp)(dir);
  });
}

// check if the given directory contains one directory only
// so that when we unzip, we should use the inner directory as
// the directory
function checkStripDir(dir) {
  return asp(fs.readdir)(dir)
  .then(function(files) {
    if (files.length > 1)
      return dir;

    if (!files.length)
      return dir;

    var dirPath = path.resolve(dir, files[0]);

    return asp(fs.stat)(dirPath)
    .then(function(stat) {
      if (stat.isDirectory())
        return dirPath;

      return dir;
    });
  });
}

function configureCredentials(config, ui) {
  var auth = {};

  return Promise.resolve()
  .then(function() {
    ui.log('info', 'You can generate an access token at %https://' + (config.hostname || 'github.com') + '/settings/tokens%.');
    return ui.input('Enter your GitHub access token');
  })
  .then(function(token) {
    auth.token = token;
    if (auth.token) {
      return ui.confirm('Would you like to test these credentials?', true);
    }
  })
  .then(function(test) {
    if (!test)
      return true;

    return Promise.resolve()
    .then(function() {
      var remotes = {};
      createRemoteStrings.call(remotes, auth, config.hostname);

      return asp(request)({
        uri: remotes.apiRemoteString + 'user' + remotes.authSuffix,
        headers: {
          'User-Agent': 'jspm',
          'Accept': 'application/vnd.github.v3+json'
        },
        followRedirect: false,
        strictSSL: 'strictSSL' in config ? config.strictSSL : true
      });
    })
    .then(function(res) {
      if (res.statusCode == 401) {
        ui.log('warn', 'Provided GitHub credentials are not authorized, try re-entering your access token.');
      }
      else if (res.statusCode != 200) {
        ui.log('warn', 'Invalid response code, %' + res.statusCode + '%');
      }
      else {
        ui.log('ok', 'GitHub authentication is working successfully.');
        return true;
      }
    }, function(err) {
      ui.log('err', err.stack || err);
    });
  })
  .then(function(authorized) {
    if (!authorized)
      return ui.confirm('Would you like to try new credentials?', true)
      .then(function(redo) {
        if (redo)
          return configureCredentials(config, ui);
        return auth.token;
      });
    else if (auth.token)
      return auth.token;
    else
      return null;
  });
}

var apiWarned = false;

// static configuration function
GithubLocation.configure = function(config, ui) {
  config.remote = config.remote || 'https://github.jspm.io';

  return (config.name != 'github' ? Promise.resolve(ui.confirm('Are you setting up a GitHub Enterprise registry?', true)) : Promise.resolve())
  .then(function(enterprise) {
    if (!enterprise)
      return;

    return Promise.resolve(ui.input('Enter the hostname of your GitHub Enterprise server', config.hostname))
    .then(function(hostname) {
      config.hostname = hostname;
    });
  })
  .then(function() {
    return Promise.resolve(ui.confirm('Would you like to set up your GitHub credentials?', true))
    .then(function(auth) {
      if (auth)
        return configureCredentials(config, ui)
        .then(function(auth) {
          config.auth = auth;
        });
      });
  })
  .then(function() {
    config.maxRepoSize = config.maxRepoSize || 0;
    return config;
  });
};

GithubLocation.packageNameFormats = ['*/*'];

GithubLocation.prototype = {

  // given a repo name, locate it and ensure it exists
  locate: function(repo) {
    var self = this;
    var remoteString = this.remoteString;
    var authSuffix = this.authSuffix;

    if (repo.split('/').length !== 2)
      throw "GitHub packages must be of the form `owner/repo`.";

    // request the repo to check that it isn't a redirect
    return new Promise(function(resolve, reject) {
      request(extend({
        uri: remoteString + repo + authSuffix,
        followRedirect: false
      }, self.defaultRequestOptions))
      .on('response', function(res) {
        // redirect
        if (res.statusCode == 301)
          resolve({ redirect: self.name + ':' + res.headers.location.split('/').splice(3).join('/') });

        if (res.statusCode == 401)
          reject('Invalid authentication details.\n' +
            'Run %jspm registry config ' + self.name + '% to reconfigure the credentials, or update them in your ~/.netrc file.');

        // it might be a private repo, so wait for the lookup to fail as well
        if (res.statusCode == 404 || res.statusCode == 200 || res.statusCode === 302)
          resolve();

        reject(new Error('Invalid status code ' + res.statusCode + '\n' + JSON.stringify(res.headers, null, 2)));
      })
      .on('error', function(error) {
        if (typeof error == 'string') {
          error = new Error(error);
          error.hideStack = true;
        }
        error.retriable = true;
        reject(error);
      });
    });
  },

  // return values
  // { versions: { versionhash } }
  // { notfound: true }
  lookup: function(repo) {
    var self = this;
    var remoteString = this.remoteString;

    return Promise.resolve()
    .then(function() {
      if(this.auth && this.auth.token) {
        // use API to get branches/tags
        return Promise.all(['tags', 'heads'].map(function(type) {
          return asp(request)(extend({
            uri: this.apiRemoteString + 'repos/' + repo + '/git/refs/' + type + this.authSuffix,
            headers: {
              'Accept': 'application/vnd.github.v3.raw'
            },
            qs: {
              ref: version
            }
          }, self.defaultRequestOptions));
        })).then(function(tagRes, headRes) {
          if (tagRes.statusCode != 200)
            throw { statusCode: tagRes.statusCode, headers: tagRes.headers, api: true };
          else if (headRes.statusCode != 200)
            throw { statusCode: headRes.statusCode, headers: tagRes.headers, api: true };

          var tags = JSON.parse(tagRes.body);
          var heads = JSON.parse(headRes.body);

          return tags.concat(heads).map(function(obj) {
            return { hash: obj.object.sha, name: obj.ref };
          });
        });
      } else {
        // fallback to git-based approach
        return lsRemote(extend({
          url: remoteString + repo + '.git'
        }, self.defaultRequestOptions));
      }
    })
    .then(function(refs) {
      var versions = {};
      refs.forEach(function(ref) {
        var version;
        var versionObj = { hash: ref.sha, meta: {} };
        if (ref.name.substr(0, 11) == 'refs/heads/') {
          version = ref.name.substr(11);
          versionObj.stable = false;
        }

        else if (ref.name.substr(0, 10) == 'refs/tags/') {
          if (ref.name.substr(ref.name.length - 3, 3) == '^{}')
            version = ref.name.substr(10, ref.name.length - 13);
          else
            version = ref.name.substr(10);

          if (version.substr(0, 1) == 'v' && semver.valid(version.substr(1))) {
            version = version.substr(1);
            // note when we remove a "v" which versions we need to add it back to
            // to work out the tag version again
            versionObj.meta.vPrefix = true;
          }
        }

        versions[version] = versionObj;
      });

      return { versions: versions };
    })
    .catch(function(error) {
      if (error.statusCode) {
        var headerSuffix = '\n' + JSON.stringify(error.headers, null, 2); 

        if (error.statusCode == 406 || error.statusCode == 401) {
          if (error.api) {
            // TODO: replace this with the api failure response
            error = new Error('api says invalid auth: ' + error.statusCode + headerSuffix);
          }
          else {
            error = new Error('Invalid authentication details.\n' +
            'Run %jspm registry config ' + self.name + '% to reconfigure the credentials, or update them in your ~/.netrc file.');
          }
        }
        else if (error.statusCode == 404)
          return { notfound: true };
        else
          error = new Error('invalid status code: ' + error.statusCode + headerSuffix);
      }

      if(typeof error == 'string') {
        error = new Error(error);
      }

      error.retriable = true;
      error.hideStack = true;
      throw error;
    });
  },

  // optional hook, allows for quicker dependency resolution
  // since download doesn't block dependencies
  getPackageConfig: function(repo, version, hash, meta) {
    if (meta.vPrefix)
      version = 'v' + version;

    var self = this;
    var ui = this.ui;

    return asp(request)(extend({
      uri: this.apiRemoteString + 'repos/' + repo + '/contents/package.json' + this.authSuffix,
      headers: {
        'Accept': 'application/vnd.github.v3.raw'
      },
      qs: {
        ref: version
      }
    }, self.defaultRequestOptions))
    .then(function(res) {
      // API auth failure warnings
      function apiFailWarn(reason, showAuthCommand) {
        if (apiWarned)
          return;

        ui.log('warn', 'Unable to use the GitHub API to speed up dependency downloads due to ' + reason
            + (showAuthCommand ? '\nTo resolve use %jspm registry config github% to configure the credentials, or update them in your ~/.netrc file.' : ''));
        apiWarned = true;
      }
      
      if (res.headers.status.match(/^401/))
        return apiFailWarn('lack of authorization', true);
      if (res.headers.status.match(/^406/))
        return apiFailWarn('insufficient permissions. Ensure you have public_repo access.');
      if (res.headers['x-ratelimit-remaining'] == '0') {
        if (self.auth)
          return apiFailWarn('the rate limit being reached, which will be reset in `' + 
              Math.round((res.headers['x-ratelimit-reset'] * 1000 - new Date(res.headers.date).getTime()) / 60000) + ' minutes`.');
        return apiFailWarn('the rate limit being reached.', true);
      }
      if (res.statusCode != 200)
        return apiFailWarn('invalid response code ' + res.statusCode + '.');

      // it is quite valid for a repo not to have a package.json
      if (res.statusCode == 404)
        return {};

      var packageJSON;
      try {
        packageJSON = JSON.parse(res.body);
      }
      catch(e) {
        throw 'Error parsing package.json';
      }

      return packageJSON;
    });
  },

  processPackageConfig: function(packageConfig, packageName) {
    if (!packageConfig.jspm || !packageConfig.jspm.files)
      delete packageConfig.files;

    var self = this;

    if ((packageConfig.dependencies || packageConfig.peerDependencies || packageConfig.optionalDependencies) && 
        !packageConfig.registry && (!packageConfig.jspm || !(packageConfig.jspm.dependencies || packageConfig.jspm.peerDependencies || packageConfig.jspm.optionalDependencies))) {
      var hasDependencies = false;
      for (var p in packageConfig.dependencies)
        hasDependencies = true;
      for (var p in packageConfig.peerDependencies)
        hasDependencies = true;
      for (var p in packageConfig.optionalDependencies)
        hasDependencies = true;

      if (packageName && hasDependencies) {
        var looksLikeNpm = packageConfig.name && packageConfig.version && (packageConfig.description || packageConfig.repository || packageConfig.author || packageConfig.license || packageConfig.scripts);
        var isSemver = semver.valid(packageName.split('@').pop());
        var noDepsMsg;

        // non-semver npm installs on GitHub can be permitted as npm branch-tracking installs
        if (looksLikeNpm) {
          if (!isSemver)
            noDepsMsg = 'To install this package as it would work on npm, install with a registry override via %jspm install ' + packageName + ' -o "{registry:\'npm\'}"%.'
          else
            noDepsMsg = 'If the dependencies aren\'t needed ignore this message. Alternatively set a `registry` or `dependencies` override or use the npm registry version at %jspm install npm:' + packageConfig.name + '@^' + packageConfig.version + '% instead.';
        }
        else {
          noDepsMsg = 'If this is your own package, add `"registry": "jspm"` to the package.json to ensure the dependencies are installed.'
        }

        if (noDepsMsg) {
          delete packageConfig.dependencies;
          delete packageConfig.peerDependencies;
          delete packageConfig.optionalDependencies;
          this.ui.log('warn', '`' + packageName + '` dependency installs skipped as it\'s a GitHub package with no registry property set.\n' + noDepsMsg + '\n');
        }
      }
      else {
        delete packageConfig.dependencies;
        delete packageConfig.peerDependencies;
        delete packageConfig.optionalDependencies;
      }
    }

    // on GitHub, single package names ('jquery') are from jspm registry
    // double package names ('components/jquery') are from github registry
    if (!packageConfig.registry || packageConfig.registry == 'github') {
      for (var d in packageConfig.dependencies)
        packageConfig.dependencies[d] = convertDependency(d, packageConfig.dependencies[d]);
      for (var d in packageConfig.peerDependencies)
        packageConfig.peerDependencies[d] = convertDependency(d, packageConfig.peerDependencies[d]);
      for (var d in packageConfig.optionalDependencies)
        packageConfig.optionalDependencies[d] = convertDependency(d, packageConfig.optionalDependencies[d]);

      function convertDependency(d, depName) {
        var depVersion;

        if (depName.indexOf(':') != -1)
          return depName;

        if (depName.indexOf('@') != -1) {
          depVersion = depName.substr(depName.indexOf('@') + 1);
          depName = depName.substr(0, depName.indexOf('@'));
        }
        else {
          depVersion = depName;
          depName = d;
        }

        if (depName.split('/').length == 1)
          return 'jspm:' + depName + (depVersion && depVersion !== true ? '@' + depVersion : '');

        return depName + '@' + depVersion;
      }
    }
    return packageConfig;
  },

  download: function(repo, version, hash, meta, outDir) {
    if (meta.vPrefix)
      version = 'v' + version;

    var max_repo_size = this.max_repo_size;
    var remoteString = this.remoteString;
    var authSuffix = this.authSuffix;

    var self = this;

    // Download from the git archive
    return new Promise(function(resolve, reject) {
      request(extend({
        uri: remoteString + repo + '/archive/' + version + '.tar.gz' + authSuffix,
        headers: { 'accept': 'application/octet-stream' }
      }, self.defaultRequestOptions))
      .on('response', function(pkgRes) {
        if (pkgRes.statusCode != 200)
          return reject('Bad response code ' + pkgRes.statusCode);

        if (max_repo_size && pkgRes.headers['content-length'] > max_repo_size)
          return reject('Response too large.');

        pkgRes.pause();

        var gzip = zlib.createGunzip();

        pkgRes
        .pipe(gzip)
        .pipe(tar.extract(outDir, {
          strip: 1,
          filter: function(_, header) {
            return header.type !== 'file' && header.type !== 'directory'
          }
        }).on('finish', resolve).on('error', reject))
        .on('error', reject);

        pkgRes.resume();

      })
      .on('error', function(err) {
        if (err.code == 'ECONNRESET')
          err.retriable = true;
        throw err;
      });
    });
  },

  // check if the main entry point exists. If not, try the bower.json main.
  processPackage: function(packageConfig, packageName, dir) {
    var main = packageConfig.main || dir.split('/').pop().split('@').slice(0, -1).join('@') + (dir.substr(dir.length - 3, 3) != '.js' ? '.js' : '');
    var libDir = packageConfig.directories && (packageConfig.directories.dist || packageConfig.directories.lib) || '.';

    if (main instanceof Array)
      main = main[0];

    if (typeof main != 'string')
      return;

    // convert to windows-style paths if necessary
    main = main.replace(/\//g, path.sep);
    libDir = libDir.replace(/\//g, path.sep);

    if (main.indexOf('!') != -1)
      return;

    function checkMain(main, libDir) {
      if (!main)
        return Promise.resolve(false);

      if (main.substr(main.length - 3, 3) == '.js')
        main = main.substr(0, main.length - 3);

      return new Promise(function(resolve, reject) {
        fs.exists(path.resolve(dir, libDir || '.', main) + '.js', function(exists) {
          resolve(exists);
        });
      });
    }

    return checkMain(main, libDir)
    .then(function(hasMain) {
      if (hasMain)
        return hasMain;

      return asp(fs.readFile)(path.resolve(dir, 'bower.json'))
      .then(function(bowerJson) {
        try {
          bowerJson = JSON.parse(bowerJson);
        }
        catch(e) {
          return;
        }

        main = bowerJson.main || '';
        if (main instanceof Array)
          main = main[0];

        return checkMain(main);
      }, function() {})
      .then(function(hasBowerMain) {
        if (hasBowerMain)
          return hasBowerMain;

        main = 'index';
        return checkMain(main, libDir);
      });
    })
    .then(function(hasMain) {
      if (hasMain)
        packageConfig.main = main.replace(/\\/g, '/');
      return packageConfig;
    });
  }

};

module.exports = GithubLocation;
