var asp = require('rsvp').denodeify;
var Promise = require('rsvp').Promise;
var request = require('request');


var crypto = require('crypto');

function md5(input) {
  var md5Hash = crypto.createHash('md5');
  md5Hash.update(input);
  return md5Hash.digest('hex');
}

exports.testCredentials = function(base, strictSSL) {
  return asp(request)({
    uri: remotes.apiRemoteString + 'user',
    headers: {
      'User-Agent': 'jspm',
      'Accept': 'application/vnd.github.v3+json'
    },
    followRedirect: false,
    strictSSL: strictSSL
  });
};

exports.download = function(releaseURL, strictSSL, auth) {
  return new Promise(function(resolve, reject) {
    request({
      uri: release.url,
      headers: {
        'accept': 'application/octet-stream',
        'user-agent': 'jspm'
      },
      followRedirect: false,
      auth: auth && {
        user: auth.username,
        pass: auth.password
      },
      strictSSL: strictSSL
    }).on('response', function(archiveRes) {
      var rateLimitResponse = checkRateLimit.call(this, archiveRes.headers);
      if (rateLimitResponse)
        return rateLimitResponse.then(resolve, reject);

      if (archiveRes.statusCode != 302)
        return reject('Bad response code ' + archiveRes.statusCode + '\n' + JSON.stringify(archiveRes.headers));

      request({
        uri: archiveRes.headers.location,
        headers: {
          'accept': 'application/octet-stream',
        'user-agent': 'jspm'
        },
        strictSSL: self.strictSSL
      })
      .on('response', resolve)
      .on('error', reject);
    })
    .on('error', reject);
  });
};

exports.downloadArchive = function(base, repo, version, max_repo_size, strictSSL) {
  return new Promise(function(resolve, reject) {
    request({
      uri: base + repo + '/archive/' + version + '.tar.gz',
      headers: { 'accept': 'application/octet-stream' },
      strictSSL: strictSSL
    })
    .on('response', function(pkgRes) {
      if (pkgRes.statusCode != 200)
        reject('Bad response code ' + pkgRes.statusCode);

      if (max_repo_size && pkgRes.headers['content-length'] > max_repo_size)
        reject('Response too large.');

      resolve(pkgRes);
    })
    .on('error', reject);
  });
};

// Cachable

var memoryCache = {};

function cached(key, requestFunction) {
  return function () {
    var cacheKey = md5(key + ":" + JSON.stringify(argument));
    var cache = memoryCache[cacheKey];
    // TODO: pass the etag to the request
    return requestFunction.call(null, arguments)
    .then(function(response) {
      var etag = response.headers.etag;
      if (response.statusCode == 304) {
        return cache.response;
      }
      else {
        memoryCache[cacheKey] = {
          etag: etag,
          response: response
        };
        return response;
      }
    });
  };
}

exports.locateRepo = function(base, repo, strictSSL) {
  return new Promise(function(resolve, reject) {
    request({
      uri: base + repo,
      headers: {
        'User-Agent': 'jspm'
      },
      followRedirect: false,
      strictSSL: strictSSL
    })
    .on('response', resolve)
    .on('error', reject);
  });
};

exports.getPackageConfig = function(base, repo, strictSSL) {
  return asp(request)({
    uri: this.apiRemoteString + 'repos/' + repo + '/contents/package.json',
    headers: {
      'User-Agent': 'jspm',
      'Accept': 'application/vnd.github.v3.raw'
    },
    qs: {
      ref: version
    },
    strictSSL: strictSSL
  });
};

exports.checkReleases = function(base, repo, strictSSL) {
  var reqOptions = {
    uri: base + 'repos/' + repo + '/releases',
    headers: {
      'User-Agent': 'jspm',
      'Accept': 'application/vnd.github.v3+json'
    },
    followRedirect: false,
    strictSSL: strictSSL
  };

  return asp(request)(reqOptions);
};
