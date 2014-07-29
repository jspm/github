var exec = require('child_process').exec;
var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var githubAPI = require('github');
var github = new githubAPI({ version: '3.0.0' });
var request = require('request');

var tar = require('tar');
var zlib = require('zlib');

var execOpt;

var https;

var log, username, password;
var remoteString;
var apiRemoteString;
var GithubLocation = function(options) {
  this.baseDir = options.baseDir;
  log = options.log === false ? false : true;
  username = options.username;
  password = options.password;
  execOpt = {
    cwd: options.tmpDir,
    timeout: options.timeout * 1000,
    killSignal: 'SIGKILL'
  };
  https = options.https || false;

  remoteString = https ? ('https://' + (username ? (username + ':' + password + '@') : '') + 'github.com/') : 'git://github.com/';
  apiRemoteString = 'https://' + (username ? (username + ':' + password + '@') : '') + 'api.github.com/repos/';
}

var clearDir = function(dir, callback) {
  fs.exists(dir, function(exists) {

    (exists ? rimraf : function(dir, callback) { callback(); })(dir, function(err) {
      if (err)
        return callback(err);

      callback();
    });
  });
}

var prepDir = function(dir, callback) {
  clearDir(dir, function(err) {
    if (err)
      return callback(err);
    mkdirp(dir, function(err) {
      if (err)
        return callback(err);

      callback();
    });

  });
}

var checkReleases = function(repo, version, hasRelease, noRelease, errback) {
  if (username)
    github.authenticate({
      type: 'basic',
      username: username,
      password: password
    });
  github.repos.listReleases({
    user: repo.split('/')[0],
    repo: repo.split('/')[1]
  }, function(err, res) {
    if (err)
      return errback();

    // run through releases list to see if we have this version tag
    for (var i = 0; i < res.length; i++) {
      var tagName = res[i].tag_name.trim();

      if (tagName == version) {
        var firstAsset = res[i].assets[0];
        if (!firstAsset)
          return noRelease();

        var assetType;

        if (firstAsset.name.substr(firstAsset.name.length - 7, 7) == '.tar.gz' || firstAsset.name.substr(firstAsset.name.length - 4, 4) == '.tgz')
          assetType = 'tar';
        else if (firstAsset.name.substr(firstAsset.name.length - 4, 4) == '.zip')
          assetType = 'zip';
        else
          return noRelease();

        return hasRelease(firstAsset.url, assetType);
      }
    }

    noRelease();
  });
}


// check if the given directory contains one directory only
// so that when we unzip, we should use the inner directory as
// the directory
function checkStripDir(dir, callback, errback) {
  fs.readdir(dir, function(err, files) {
    if (err)
      return errback(err);

    if (files.length > 1)
      return callback(dir);

    var dirPath = path.resolve(dir, files[0]);

    fs.stat(dirPath, function(err, stat) {
      if (err)
        return errback(err);
      if (stat.isDirectory())
        return callback(dirPath);
      return callback(dir);
    });
  });
}


GithubLocation.prototype = {

  degree: 2,

  // always an exact version
  // assumed that this is run after getVersions so the repo exists
  download: function(repo, version, hash, outDir, callback, errback) {
    var _errback = errback;
    errback = function(err) {
      return _errback(err);
    }
    if (log)
      console.log(new Date() + ': Requesting package github:' + repo);

      // check if this version tag has release assets associated with it
      checkReleases(repo, version, function hasRelease(archiveURL, type) {
        var inPipe;

        var downloaded, packageJSON;
        var complete = function() {
          if (downloaded && packageJSON)
            callback(packageJSON);
        }

        if (type == 'tar') {
          inPipe = zlib.createGunzip()
          .pipe(tar.Extract({ path: outDir, strip: 1 }))
          .on('end', function() {
            downloaded = true;
            complete();
          });
        }
        else if (type == 'zip') {
          var tmpDir = path.resolve(execOpt.cwd, 'release-' + repo.replace('/', '#') + '-' + version);
          var tmpFile = tmpDir + '.' + type;
          if (process.platform.match(/^win/))
            return errback('No unzip support for windows yet due to https://github.com/nearinfinity/node-unzip/issues/33. Please post a jspm-cli issue.');
          inPipe = fs.createWriteStream(tmpFile)
          .on('finish', function() {
            exec('unzip -o ' + tmpFile + ' -d ' + tmpDir + ' && chmod -R +w ' + tmpDir, execOpt, function(err) {
              if (err)
                return errback(err);

              // check if it extracted to a single dir and use that
              checkStripDir(tmpDir, function(repoDir) {
                // now rename tmpDir/dist to outDir
                prepDir(outDir, function(err) {
                  if (err)
                    return errback(err);
                  fs.rename(repoDir, outDir, function(err) {
                    if (err)
                      return errback(err);

                    // if it was a subdir, remove the base dir too
                    if (repoDir != tmpDir)
                      fs.rmdirSync(tmpDir);

                    fs.unlink(tmpFile, function() {
                      downloaded = true;
                      complete();
                    });
                  });
                });
              }, errback);
            });
          });
        }
        else {
          return errback('Github release found, but no archive present.');
        }

        // in parallel, check the underlying repo for a package.json
        var reqOptions = {
          uri: 'https://raw.githubusercontent.com/' + repo + '/' + hash + '/package.json',
          strictSSL: false
        };
        if (username)
          reqOptions.auth = {
            user: username,
            pass: password
          };
        
        request(reqOptions, function(err, res, body) {
          if (res.statusCode == 404) {
            packageJSON = {};
            return complete();
          }
          if (err || res.statusCode != 200)
            return errback('Unable to check repo package.json for release');
          try {
            packageJSON = JSON.parse(body);
          }
          catch(e) {
            return errback('Error parsing package.json');
          }

          complete();
        });

        // has a release archive
        request({
          uri: archiveURL, 
          headers: { 
            'accept': 'application/octet-stream', 
            'user-agent': 'jspm'
          },
          strictSSL: false
        }).on('response', function(archiveRes) {
          if (archiveRes.statusCode != 200)
            return errback('Bad response code ' + archiveRes.statusCode + '\n' + JSON.sringify(archiveRes.headers));
          
          if (archiveRes.headers['content-length'] > 100000000)
            return errback('Response too large.');

          archiveRes.pause();

          archiveRes.pipe(inPipe);

          archiveRes.on('error', errback);

          archiveRes.resume();
        })
        .on('error', errback);

      }, function noRelease() {

        request({
          uri: remoteString + repo + '/archive/' + version + '.tar.gz',
          headers: { 'accept': 'application/octet-stream' },
          strictSSL: false
        })
        .on('response', function(pkgRes) {

          if (pkgRes.statusCode != 200)
            return errback('Bad response code ' + pkgRes.statusCode);
          
          if (pkgRes.headers['content-length'] > 10000000)
            return errback('Response too large.');

          pkgRes.pause();

          var gzip = zlib.createGunzip();

          pkgRes
          .pipe(gzip)
          .pipe(tar.Extract({ path: outDir, strip: 1 }))
          .on('error', errback)
          .on('end', callback);

          pkgRes.resume();

        })
        .on('error', errback);

      }, errback);

  },

  getVersions: function(repo, callback, errback) {

    var passed = 0;
    var error = false;
    var versions;

    // request the repo to check that it isn't a redirect!
    request({
      uri: apiRemoteString + repo,
      headers: {
          'User-Agent': "jspm"
      },
      strictSSL: false,
      followRedirect: false
    })
    .on('response', function(res) {
      //not found
      if (res.statusCode == 301 || res.statusCode == 404) {
        error = true;
        return callback();
      }
      //other error
      else if (res.statusCode != 200) {
        error = true;
        return errback(res.statusCode);
      }
      if (error)
        return;
      
      passed++;

      if (passed == 2)
        callback(versions);
    })
    .on('error', function(err) {
      error = true;
      errback(err);
    });

    exec('git ls-remote ' + remoteString + repo + '.git refs/tags/* refs/heads/*', execOpt, function(err, stdout, stderr) {

      if (err) {
        error = true;
        if ((err + '').indexOf('Repository not found') != -1)
          return callback();
        return errback(stderr);
      }

      versions = {};
      var refs = stdout.split('\n');
      for (var i = 0; i < refs.length; i++) {
        if (!refs[i])
          continue;
        
        var hash = refs[i].substr(0, refs[i].indexOf('\t'));
        var refName = refs[i].substr(hash.length + 1);

        if (refName.substr(0, 11) == 'refs/heads/')
          versions[refName.substr(11)] = hash;
        else if (refName.substr(0, 10) == 'refs/tags/') {
          if (refName.substr(refName.length - 3, 3) == '^{}')
            versions[refName.substr(10, refName.length - 13)] = hash;
          else
            versions[refName.substr(10)] = hash;
        }
      }

      passed++;
      if (passed == 2)
        callback(versions);
    });
  }
};

module.exports = GithubLocation;
