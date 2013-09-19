var exec = require('child_process').exec;
var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var githubAPI = require('github');
var github = new githubAPI({ version: '3.0.0' });

var execOpt;

var GithubLocation = function(options) {
  this.baseDir = options.baseDir;
  this.log = options.log === false ? false : true;
  execOpt = {
    cwd: options.tmpDir,
    timeout: options.timeout * 1000,
    killSignal: 'SIGKILL'
  };
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
      
      exec('git clone --mirror ' + 'git://github.com/' + repo + '.git ' + repoFile, execOpt, function(err) {

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

var prepDir = function(dir, callback) {
  fs.exists(dir, function(exists) {

    (exists ? rimraf : function(dir, callback) { callback(); })(dir, function(err) {
      if (err)
        return callback(err);

      mkdirp(dir, function(err) {
        if (err)
          return callback(err);

        callback();
      });

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
    // and clear the output directory if necessary
    prepDir(outDir, function(err) {
      if (err)
        return errback(err);

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
      });

    });
  },

  getVersions: function(repo, callback, errback) {

    if (this.log)
      console.log(new Date() + ': Requesting package github:' + repo);
    /*
    github.gitdata.getAllReferences({
      user: repo.split('/')[0],
      repo: repo.split('/')[1],
      per_page: 100
    }, function(err, result) {
      if (err)
        return errback(err);
      if (!result)
        return errback('No results.');

      var versions = {};
      for (var i = 0; i < result.length; i++) {
        if (!result[i])
          continue;
        
        var hash = result[i].object && result[i].object.sha;
        var refName = result[i].ref;

        if (!hash || !refName)
          continue;

        if (refName.substr(0, 11) == 'refs/heads/')
          versions[refName.substr(11)] = hash;
        else if (refName.substr(0, 10) == 'refs/tags/')
          versions[refName.substr(10)] = hash;
      }

      callback(versions);
    });
    */
    var repoFile = repo.replace('/', '#') + '.git';
    touchRepo(repo, function(notfound) {

      if (notfound)
        return callback();
    
      exec('git --git-dir=' + repoFile + ' ls-remote --heads --tags', execOpt, function(err, stdout, stderr) {
        if (err)
          return errback(stderr);

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