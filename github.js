var exec = require('child_process').exec;
var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');

var execOpt;

var GithubLocation = function(options) {
  this.baseDir = options.baseDir;
  this.log = options.log === false ? false : true;
  execOpt = {
    cwd: options.tmpDir,
    timeout: options.timeout * 1000,
    
  };
}

var touchRepo = function(repo, callback, errback) {
  var repoFile = repo.replace('/', '#') + '.git';
  // ensure git repo exists, if not do a git clone
  fs.stat(path.resolve(execOpt.cwd, repoFile), function(err, stats) {
    if (!err && stats.isDirectory())
      return callback();

    exec('git clone --mirror ' + 'git://github.com/' + repo + '.git ' + repoFile, execOpt, function(err) {

      if (err) {
        if (err.toString().indexOf('Repository not found') != -1)
          return callback(true);

        return errback(err);
      }

      callback();
    });
  });
}

GithubLocation.prototype = {

  degree: 2,

  // always an exact version
  // assumed that this is run after getVersions so the repo exists
  download: function(repo, version, hash, outDir, callback, errback) {
    var repoFile = repo.replace('/', '#') + '.git';

    // ensure the output directory exists
    try {
      mkdirp.sync(outDir);
    }
    catch (e) {
      return errback(e);
    }

    // do a full download
    exec('git --git-dir=' + repoFile + ' remote update', execOpt, function(err) {
      if (err)
        return errback(err);

      exec('git --work-tree=' + outDir + ' --git-dir=' + repoFile + ' reset --hard ' + hash, execOpt, function(err, stdout, stderr) {
        if (err)
          return errback(err);
        callback();
      });

    });
  },

  getVersions: function(repo, callback, errback) {

    if (this.log)
      console.log(new Date() + ': Requesting package github:' + repo);

    touchRepo(repo, function(notfound) {

      if (notfound)
        return callback();

      var repoFile = repo.replace('/', '#') + '.git';

      exec('git --git-dir=' + repoFile + ' ls-remote --heads --tags', execOpt, function(err, stdout) {
        if (err)
          return errback(err);

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

    }, errback);

  }
};

module.exports = GithubLocation;