var asp = require('bluebird').Promise.promisify;
var request = asp(require('request'));

module.exports = function(opts) {
  return Promise.resolve()
  .then(function() {
    opts.encoding = null;
    opts.url += '/info/refs?service=git-upload-pack';

    return request(opts)
  })
  .then(function(response) {
    if (response.statusCode != 200) throw { statusCode: response.statusCode, headers: response.headers };
    // per the specification, content-type must be this
    if (response.headers['content-type'] != 'application/x-git-upload-pack-advertisement')  throw { statusCode: 500, headers: response.statusCode };

    var body = response.body;
    var lines = [];
    var pos = 0;
    while (pos < body.length) {
      // read 4 bytes and parse line length in hex
      var lineLength = parseInt(body.toString('utf8', pos, pos + 4), 16);
      // if line isn't blank, read it, otherwise read the next line
      if (lineLength != 0) {
        var line = body.toString('utf8', pos + 4, pos += lineLength);
        lines.push(line.trim());
      } else pos += 4;
    }

    // verify the first line is git-upload-pack
    if( lines.shift() != '# service=git-upload-pack') throw { statusCode: 500, headers: response.headers };

    // verify the second line is the HEAD
    // e.g. 21d0a9aa00806bb7f67ef5cd98c876aa20e4d803 HEAD\u0000multi_ack thin-pack [...]
    if (lines.shift().substr(41, 4) != 'HEAD') throw { statusCode: 500, headers: response.headers };

    // parse the remaining lines
    var refs = lines.map(function(line) {
      return {
        sha: line.substr(0, 40),
        name: line.substr(41)
      };
    });

    return refs;
  });
}

// for reference:
/*
  smart_reply     =  PKT-LINE("# service=$servicename" LF)
         ref_list
         "0000"
  ref_list        =  empty_list / non_empty_list

  empty_list      =  PKT-LINE(zero-id SP "capabilities^{}" NUL cap-list LF)

  non_empty_list  =  PKT-LINE(obj-id SP name NUL cap_list LF)
         *ref_record

  cap-list        =  capability *(SP capability)
  capability      =  1*(LC_ALPHA / DIGIT / "-" / "_")
  LC_ALPHA        =  %x61-7A

  ref_record      =  any_ref / peeled_ref
  any_ref         =  PKT-LINE(obj-id SP name LF)
  peeled_ref      =  PKT-LINE(obj-id SP name LF)
         PKT-LINE(obj-id SP name "^{}" LF
*/
