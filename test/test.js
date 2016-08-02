var githubRegistry = require('../github');

testSuits('Github', '');
if (process.env.token)
  testSuits('Github with token auth', process.env.token);
if (process.env.ghuser)
  testSuits('Github with user:token auth', new Buffer(process.env.ghuser + ':' + process.env.token).toString('base64'));

function testSuits(name, auth) {
  suite(name, function() {
    var github = new githubRegistry({
      baseDir: '.',
      log: true,
      tmpDir: '.',
      auth: auth,
      name: 'github'
    });

    suite('locate', function() {
      test('jspm/github', function() {
        return github.locate('jspm/github', 'jspm/github exists');
      });

      test('6to5/6to5', function() {
        return github.locate('6to5/6to5').then(function(result) {
          assert(result.redirect, 'has redirect');
          assert.equal(result.redirect, 'github:babel/babel', 'redirect points to babel/babel');
        });
      });

      test('jspm/thisdoesnotexist', function() {
        return github.locate('jspm/thisdoesnotexist').then(function() {
          // todo: this should throw if using the api
          // assert(false);
        });
      });
    });

    suite('lookup', function() {
      test('jspm/github@0.13.16', function() {
        var tag = '0.13.16';
        var sha = '21d0a9aa00806bb7f67ef5cd98c876aa20e4d803';
        return github.lookup('jspm/github').then(function(result) {
          assert(result.versions[tag].hash === sha);
        });
      });
    });
  });
}