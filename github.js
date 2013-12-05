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
}

var touchRepo = function(repo, callback, errback) {
  var repoFile = repo.replace('/', '#') + '.git';
  // ensure git repo exists, if not do a git clone
  fs.exists(path.resolve(execOpt.cwd, repoFile, 'config'), function(exists) {
    if (exists)
      return callback();

    prepDir(path.resolve(execOpt.cwd, repoFile), function(err) {
      if (err)
        return errback(err);
      
      exec('git clone --mirror ' + remoteString + repo + '.git ' + repoFile, execOpt, function(err) {

        if (err) {
          if (err.toString().indexOf('Repository not found') != -1)
            return callback(true);

          return errback(err);
        }

        callback();
      });

    });
  });
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
      if (tagName.substr(0, 1) == 'v')
        tagName = tagName.substr(1).trim();

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

GithubLocation.prototype = {

  degree: 2,

  // always an exact version
  // assumed that this is run after getVersions so the repo exists
  download: function(repo, version, hash, outDir, callback, errback) {
    if (log)
      console.log(new Date() + ': Requesting package github:' + repo);

    var repoFile = repo.replace('/', '#') + '.git';

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
          .pipe(tar.Extract({ path: outDir }))
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
            exec('unzip -o ' + tmpFile + ' -d ' + tmpDir, execOpt, function(err) {
              if (err)
                return errback(err);

              // now rename tmpDir/dist to outDir
              prepDir(outDir, function(err) {
                if (err)
                  return errback(err);
                fs.rename(tmpDir, outDir, function(err) {
                  if (err)
                    return errback(err);

                  fs.unlink(tmpFile, function() {
                    downloaded = true;
                    complete();
                  });
                });
              });
            });
          });
        }
        else {
          return errback('Github release found, but no archive present.');
        }

        // in parallel, check the underlying repo for a package.json
        request({
          uri: 'https://raw.github.com/' + repo + '/' + hash + '/package.json',
          strictSSL: false
        }, function(err, res, body) {
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
            return errback('Bad response code ' + archiveRes.statusCode + '\n' + archiveRes.headers);
          
          if (archiveRes.headers['content-length'] > 10000000)
            return errback('Response too large.');

          archiveRes.pause();

          archiveRes.pipe(inPipe);

          archiveRes.on('error', errback);

          archiveRes.resume();
        })
        .on('error', errback);

      }, function noRelease() {

        // ensure the output directory exists
        // and clear the output directory if necessary
        prepDir(outDir, function(err) {
          if (err)
            return errback(err);

          // no release archive
          touchRepo(repo, function(notfound) {

            if (notfound)
              return callback();

            // do a full download
            exec('git --git-dir=' + repoFile + ' remote update', execOpt, function(err, stdout, stderr) {
              if (err)
                return errback(stderr);

              exec('git --work-tree=' + outDir + ' --git-dir=' + repoFile + ' reset --hard ' + hash, execOpt, function(err, stdout, stderr) {
                if (err)
                  return errback(stderr);
                callback();
              });

            });
          }, errback);


        });

      }, errback);

  },

  getVersions: function(repo, callback, errback) {
    exec('git ls-remote ' + remoteString + repo + '.git refs/tags/* refs/heads/*', execOpt, function(err, stdout, stderr) {
      if (err) {
        if ((err + '').indexOf('Repository not found') != -1)
          return callback();
        return errback(stderr);
      }

      var versions = {};
      var refs = stdout.split('\n');
      for (var i = 0; i < refs.length; i++) {
        if (!refs[i])
          continue;
        
        var hash = refs[i].substr(0, refs[i].indexOf('\t'));
        var refName = refs[i].substr(hash.length + 1);

        if (refName.substr(0, 11) == 'refs/heads/')
          versions[refName.substr(11)] = hash;
        else if (refName.substr(0, 10) == 'refs/tags/')
          versions[refName.substr(10)] = hash;
      }

      callback(versions);
    });

  }
};

module.exports = GithubLocation;
