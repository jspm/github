const exec = require('child_process').exec;
const os = require('os');

class Pool {
  constructor (count) {
    this.count = count;
    this.queue = [];
    this.promises = new Array(count);
  }
}

/* Run the function immediately. */
function run (pool, idx, executionFunction) {
  var p = Promise.resolve()
  .then(executionFunction)
  .then(() => {
    delete pool.promises[idx];
    var next = pool.queue.pop();
    if (next)
      pool.execute(next);
  });
  pool.promises[idx] = p;
  return p;
}

/* Defer function to run once all running and queued functions have run. */
function enqueue (pool, executeFunction) {
  return new Promise(resolve => {
    pool.queue.push(() => {
      return Promise.resolve()
      .then(executeFunction)
      .then(resolve);
    });
  });
}

/* Take a function to execute within pool, and return promise delivering the functions
 * result immediately once it is run. */
Pool.prototype.execute = function (executionFunction) {
  var idx = -1;
  for (var i = 0; i < this.count; i++)
    if (!this.promises[i])
      idx = i;
  if (idx !== -1)
    return run(this, idx, executionFunction);
  else
    return enqueue(this, executionFunction);
};

if (process.platform === 'win32') {
  var gitPool = new Pool(Math.min(os.cpus().length, 2));
  module.exports = function (command, execOpt) {
    return new Promise((topResolve, topReject) => {
      return gitPool.execute(function() {
        return new Promise(resolve => {
          exec('git ' + command, execOpt, (err, stdout, stderr) => {
            if (err)
              topReject(stderr || err);
            else
              topResolve(stdout);
            resolve();
          });
        });
      });  
    });
  };
}
else {
  module.exports = (command, execOpt) => new Promise((resolve, reject) => {
    exec('git ' + command, execOpt, (err, stdout, stderr) => {
      if (err)
        reject(stderr || err);
      else
        resolve(stdout);
    });
  });
}
