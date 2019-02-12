const { Semver, SemverRange } = require('sver');
const execGit = require('./exec-git');
const { URL } = require('url');

const githubApiAcceptHeader = 'application/vnd.github.v3+json';
const githubApiRawAcceptHeader = 'application/vnd.github.v3.raw';

const commitRegEx = /^[a-f0-9]{6,}$/;
const wildcardRange = new SemverRange('*');

const githubApiAuth = process.env.JSPM_GITHUB_AUTH_TOKEN ? {
  username: 'envtoken',
  password: process.env.JSPM_GITHUB_AUTH_TOKEN
} : null;

module.exports = class GithubEndpoint {
  constructor (util, config) {
    this.userInput = config.userInput;
    this.util = util;

    this.timeout = config.timeout;
    this.strictSSL = config.strictSSL;
    this.instanceId = Math.round(Math.random() * 10**10);

    if (config.auth) {
      this._auth = readAuth(config.auth);
      if (!this._auth)
        this.util.log.warn(`${this.util.bold(`registries.github.auth`)} global github registry auth token is not a valid token format.`);
    }
    else {
      this._auth = undefined;
    }
    
    this.credentialsAttempts = 0;

    if (config.host && config.host !== 'github.com') {
      // github enterprise support
      this.githubUrl = 'https://' + (config.host[config.host.length - 1] === '/' ? config.host.substr(0, config.host.length - 1) : config.host);
      this.githubApiUrl = `https://${this.githubApiHost}/api/v3`;
    }
    else {
      this.githubUrl = 'https://github.com';
      this.githubApiUrl = 'https://api.github.com';
    }

    this.execOpt = {
      timeout: this.timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 100 * 1024 * 1024,
      env: Object.assign({
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSL_NO_VERIFY: this.strictSSL ? '0' : '1'
      }, process.env)
    };

    this.gettingCredentials = false;
    this.rateLimited = false;
    this.freshLookups = {};
    
    // by default, "dependencies" are taken to be from npm registry
    // unless there is an explicit "registry" property
    this.dependencyRegistry = 'npm';
  }

  dispose () {
  }

  /*
   * Registry config
   */
  async configure () {
    this.gettingCredentials = true;
    await this.ensureAuth(this.util.getCredentials(this.githubUrl), true);
    this.gettingCredentials = false;
    this.util.log.ok('GitHub authentication updated.');
  }

  async auth (url, credentials, unauthorized) {
    if (unauthorized || this._auth) {
      const origin = url.origin;
      if (origin === this.githubUrl || origin === this.githubApiUrl) {
        // unauthorized -> fresh auth token
        if (unauthorized)
          await this.ensureAuth(credentials, true);
        // update old jspm auth format to an automatically generated token, so we always use tokens
        // (can be deprecated eventually)
        else if (this._auth && !isGithubApiToken(this._auth.password) && !this.gettingCredentials)
          await this.ensureAuth(credentials);
        credentials.basicAuth = githubApiAuth || this._auth;
        return true;
      }
    }
  }

  async ensureAuth (credentials, invalid) {
    if (invalid || !this._auth) {
      if (!this.userInput)
        return;

      const username = await this.util.input('Enter your GitHub username', this._auth && this._auth.username !== 'Token' ? this._auth.username : '', {
        edit: true,
        info: `jspm can generate an authentication token to install packages from GitHub with the best performance and for private repo support. Leave blank to remove jspm credentials.`
      });
      
      if (!username) {
        this.util.globalConfig.set('registries.github.auth', undefined);
        return;
      }
      else {
        const password = await this.util.input('Enter your GitHub password or access token', {
          info: `Your password is not saved locally and is only used to generate a token with the permission for repo access ${this.util.bold('repo')} to be saved into the jspm global configuration. Alternatively, you can generate an access token manually from ${this.util.bold(`${this.githubUrl}/settings/tokens`)}.`,
          silent: true,
          validate (input) {
            if (!input)
              return 'Please enter a valid GitHub password or token.';
          }
        });
        if (isGithubApiToken(password)) {
          this.util.globalConfig.set('registries.github.auth', password);
          return;
        }

        credentials.basicAuth = { username, password };
      }
    }

    const getAPIToken = async (otp) => {
      // get an API token if using basic auth
      const res = await this.util.fetch(`${this.githubApiUrl}/authorizations`, {
        method: 'POST',
        headers: {
          accept: githubApiAcceptHeader,
          'X-GitHub-OTP': otp
        },
        body: JSON.stringify({
          scopes: ['repo'],
          note: 'jspm token ' + Math.round(Math.random() * 10**10)
        }),
        timeout: this.timeout,
        credentials,
        reauthorize: false
      });
      switch (res.status) {
        case 201:
          const response = await res.json();
          this.util.globalConfig.set('registries.github.auth', response.token);
          this._auth = credentials.basicAuth = {
            username: 'Token',
            password: response.token
          };
          this.util.log.ok('GitHub token generated successfully from basic auth credentials.');
        break;
        case 401:
          if (!this.userInput)
            return;
          if (++this.credentialsAttempts === 3)
            throw new Error(`Unable to setup GitHub credentials.`);
          const otpHeader = res.headers.get('x-github-otp');
          if (otpHeader && otpHeader.startsWith('required')) {
            const otp = await this.util.input('Please enter your GitHub 2FA token', {
              validate (input) {
                if (!input || input.length !== 6 || !input.match(/^[0-9]{6}$/))
                  return 'Please enter a valid GitHub 6 digit 2FA Token.';
              }
            });
            return getAPIToken(otp);
          }
          this.util.log.warn('GitHub username and password combination is invalid. Please enter your details again.');
          return await this.ensureAuth(credentials, true);
        break;
        default:
          throw new Error(`Bad GitHub API response code ${res.status}: ${res.statusText}`);
      }
    };
    return getAPIToken();
  }

  /*
   * Resolved object has the shape:
   * { source?, dependencies?, peerDependencies?, optionalDependencies?, deprecated?, override? }
   */
  async lookup (packageName, versionRange, lookup) {
    if (lookup.redirect && this.freshLookups[packageName])
      return false;

    // first check if we have a redirect
    {
      try {
        var res = await this.util.fetch(`${this.githubApiUrl}/${packageName}`, {
          headers: {
            'User-Agent': 'jspm'
          },
          redirect: 'manual',
          timeout: this.timeout
        });
      }
      catch (err) {
        err.retriable = true;
        throw err;
      }

      switch (res.status) {
        case 301:
          lookup.redirect = `github:${res.headers.get('location').split('/').splice(3).join('/')}`;
          return true;
        
        // it might be a private repo, so wait for the lookup to fail as well
        case 200:
        case 404:
        case 302:
        break

        case 401:
          var e = new Error(`Invalid GitHub authentication details. Run ${this.util.bold(`jspm registry config github`)} to configure.`);
          e.hideStack = true;
          throw e;

        default:
          throw new Error(`Invalid status code ${res.status}: ${res.statusText}`);
      }
    }

    // cache lookups per package for process execution duration
    if (this.freshLookups[packageName])
      return false;

    // could filter to range in this lookup, but testing of eg `git ls-remote https://github.com/twbs/bootstrap.git refs/tags/v4.* resf/tags/v.*`
    // didn't reveal any significant improvement
    let url = this.githubUrl;
    let credentials = await this.util.getCredentials(this.githubUrl);
    if (credentials.basicAuth) {
      let urlObj = new URL(url);
      ({ username: urlObj.username, password: urlObj.password } = credentials.basicAuth);
      url = urlObj.href;
      // href includes trailing `/`
      url = url.substr(0, url.length - 1);
    }

    try {
      var stdout = await execGit(`ls-remote ${url}/${packageName}.git refs/tags/* refs/heads/*`, this.execOpt);
    }
    catch (err) {
      const str = err.toString();
      // not found
      if (str.indexOf('not found') !== -1)
        return;
      // invalid credentials
      if (str.indexOf('Invalid username or password') !== -1 || str.indexOf('fatal: could not read Username') !== -1) {
        let e = new Error(`git authentication failed resolving GitHub package ${this.util.highlight(packageName)}.
Make sure that git is locally configured with permissions to ${this.githubUrl} or run ${this.util.bold(`jspm registry config github`)}.`, err);
        e.hideStack = true;
        throw e;
      }
      throw err;
    }

    let refs = stdout.split('\n');
    for (let ref of refs) {
      if (!ref)
        continue;

      let hash = ref.substr(0, ref.indexOf('\t'));
      let refName = ref.substr(hash.length + 1);
      let version;

      if (refName.substr(0, 11) === 'refs/heads/') {
        version = refName.substr(11);
      }
      else if (refName.substr(0, 10) === 'refs/tags/') {
        if (refName.substr(refName.length - 3, 3) === '^{}')
          version = refName.substr(10, refName.length - 13);
        else
          version = refName.substr(10);

        if (version.substr(0, 1) === 'v' && Semver.isValid(version.substr(1)))
          version = version.substr(1);
      }

      const encoded = this.util.encodeVersion(version);
      const existingVersion = lookup.versions[encoded];
      if (!existingVersion)
        lookup.versions[encoded] = { resolved: undefined, meta: { expected: hash, resolved: undefined } };
      else
        existingVersion.meta.expected = hash;
    }
    return true;
  }

  async resolve (packageName, version, lookup) {
    let changed = false;
    let versionEntry;

    // first ensure we have the right ref hash
    // an exact commit is immutable
    if (!commitRegEx.test(version)) {
      versionEntry = lookup.versions[version];
      if (!versionEntry)
        lookup.versions[version] = versionEntry = { resolved: undefined, meta: { expected: version, resolved: undefined } };
    }
    // we get refs through the full remote-ls lookup
    else if (!(packageName in this.freshLookups)) {
      await this.lookup(packageName, wildcardRange, lookup);
      changed = true;
      versionEntry = lookup.versions[version];
      if (!versionEntry)
        return changed;
    }

    // next we fetch the package.json file for that ref hash, to get the dependency information
    // to populate into the resolved object
    if (!versionEntry.resolved || versionEntry.meta.resolved !== versionEntry.meta.expected) {
      changed = true;
      const hash = versionEntry.meta.expected;

      const resolved = versionEntry.resolved = {
        source: `${this.githubUrl}/${packageName}/archive/${hash}.tar.gz`,
        override: undefined
      };

      // if this fails, we just get no preloading
      if (!this.rateLimited) {
        const res = await this.util.fetch(`${this.githubApiUrl}/repos/${packageName}/contents/package.json?ref=${hash}`, {
          headers: {
            'User-Agent': 'jspm',
            accept: githubApiRawAcceptHeader
          },
          timeout: this.timeout
        });
        switch (res.status) {
          case 404:
            // repo can not have a package.json
          break;
          case 200:
            const pjson = await res.json();
            resolved.override = {
              dependencies: pjson.dependencies,
              peerDependencies: pjson.peerDependencies,
              optionalDepdnencies: pjson.optionalDependencies
            }
          break;
          case 401:
            apiWarn(this.util, `Invalid GitHub API credentials`);
          break;
          case 403:
            apiWarn(this.util, `GitHub API rate limit reached`);
            this.rateLimited = true;
          break;
          case 406:
            apiWarn(this.util, `GitHub API token doesn't have the right access permissions`);
          break;
          default:
            apiWarn(this.util, `Invalid GitHub API response code ${res.status}`);
        }
        function apiWarn (util, msg) {
          util.warn(`${msg} attempting to preload dependencies for ${packageName}.`);
        }
      }

      versionEntry.meta.resolved = hash;
    }

    return changed;
  }
};

function readAuth (auth) {
  // no auth
  if (!auth)
    return;
  // auth is an object
  if (typeof auth === 'object' && typeof auth.username === 'string' && typeof auth.password === 'string')
    return auth;
  else if (typeof auth !== 'string')
    return;
  // jspm 2 auth form - just a token
  if (isGithubApiToken(auth)) {
    return { username: 'Token', password: auth };
  }
  // jspm 0.16/0.17 auth form backwards compat
  // (base64(encodeURI(username):encodeURI(password)))
  try {
    let auth = new Buffer(auth, 'base64').toString('utf8').split(':');
    if (auth.length !== 2)
      return;
    let username = decodeURIComponent(auth[0]);
    let password = decodeURIComponent(auth[1]);
    return { username, password };
  }
  // invalid auth
  catch (e) {
    return;
  }
}


function isGithubApiToken (str) {
  if (str && str.length === 40 && str.match(/^[a-f0-9]+$/))
    return true;
  else
    return false;
}