'use strict';

const {
  isIterable,
  isNodeStream,
  isDestroyed,
  isReadableNodeStream,
  isWritableNodeStream,
  isDuplexNodeStream,
  isReadableFinished,
  isWritableEnded,
} = require('internal/streams/utils');
const eos = require('internal/streams/end-of-stream');
const {
  AbortError,
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_RETURN_VALUE,
  },
} = require('internal/errors');
const { destroyer } = require('internal/streams/destroy');
const Duplex = require('internal/streams/duplex');
const Readable = require('internal/streams/readable');
const { createDeferredPromise } = require('internal/util');
const from = require('internal/streams/from');

const {
  isBlob,
} = require('internal/blob');

const {
  FunctionPrototypeCall
} = primordials;

function isReadable(stream) {
  const r = isReadableNodeStream(stream);
  if (r === null || typeof stream?.readable !== 'boolean') return null;
  if (isDestroyed(stream)) return false;
  return r && stream.readable && !isReadableFinished(stream);
}

function isWritable(stream) {
  const r = isWritableNodeStream(stream);
  if (r === null || typeof stream?.writable !== 'boolean') return null;
  if (isDestroyed(stream)) return false;
  return r && stream.writable && !isWritableEnded(stream);
}

// This is needed for pre node 17.
class Duplexify extends Duplex {
  constructor(options) {
    super(options);

    // https://github.com/nodejs/node/pull/34385

    if (options?.readable === false) {
      this._readableState.readable = false;
      this._readableState.ended = true;
      this._readableState.endEmitted = true;
    }

    if (options?.writable === false) {
      this._writableState.writable = false;
      this._writableState.ending = true;
      this._writableState.ended = true;
      this._writableState.finished = true;
    }
  }
}

module.exports = function duplexify(body, name) {
  if (isDuplexNodeStream(body)) {
    return body;
  }

  if (isReadableNodeStream(body)) {
    return _duplexify({ readable: body });
  }

  if (isWritableNodeStream(body)) {
    return _duplexify({ writable: body });
  }

  if (isNodeStream(body)) {
    return _duplexify({ writable: false, readable: false });
  }

  // TODO: Webstreams
  // if (isReadableStream(body)) {
  //   return _duplexify({ readable: Readable.fromWeb(body) });
  // }

  // TODO: Webstreams
  // if (isWritableStream(body)) {
  //   return _duplexify({ writable: Writable.fromWeb(body) });
  // }

  if (typeof body === 'function') {
    const { value, write, final } = fromAsyncGen(body);

    if (isIterable(value)) {
      return from(Duplexify, value, {
        // TODO (ronag): highWaterMark?
        objectMode: true,
        write,
        final
      });
    }

    const then = value?.then;
    if (typeof then === 'function') {
      let d;

      const promise = FunctionPrototypeCall(
        then,
        value,
        (val) => {
          if (val != null) {
            throw new ERR_INVALID_RETURN_VALUE('nully', 'body', val);
          }
        },
        (err) => {
          destroyer(d, err);
        }
      );

      return d = new Duplexify({
        // TODO (ronag): highWaterMark?
        objectMode: true,
        readable: false,
        write,
        final(cb) {
          final(async () => {
            try {
              await promise;
              process.nextTick(cb, null);
            } catch (err) {
              process.nextTick(cb, err);
            }
          });
        }
      });
    }

    throw new ERR_INVALID_RETURN_VALUE(
      'Iterable, AsyncIterable or AsyncFunction', name, value);
  }

  if (isBlob(body)) {
    return duplexify(body.arrayBuffer());
  }

  if (isIterable(body)) {
    return from(Duplexify, body, {
      // TODO (ronag): highWaterMark?
      objectMode: true,
      writable: false
    });
  }

  // TODO: Webstreams.
  // if (
  //   isReadableStream(body?.readable) &&
  //   isWritableStream(body?.writable)
  // ) {
  //   return Duplexify.fromWeb(body);
  // }

  if (
    typeof body?.writable === 'object' ||
    typeof body?.readable === 'object'
  ) {
    const readable = body?.readable ?
      isReadableNodeStream(body?.readable) ? body?.readable :
        duplexify(body.readable) :
      undefined;

    const writable = body?.writable ?
      isWritableNodeStream(body?.writable) ? body?.writable :
        duplexify(body.writable) :
      undefined;

    return _duplexify({ readable, writable });
  }

  const then = body?.then;
  if (typeof then === 'function') {
    let d;

    FunctionPrototypeCall(
      then,
      body,
      (val) => {
        if (val != null) {
          d.push(val);
        }
        d.push(null);
      },
      (err) => {
        destroyer(d, err);
      }
    );

    return d = new Duplexify({
      objectMode: true,
      writable: false,
      read() {}
    });
  }

  throw new ERR_INVALID_ARG_TYPE(
    name,
    ['Blob', 'ReadableStream', 'WritableStream', 'Stream', 'Iterable',
     'AsyncIterable', 'Function', '{ readable, writable } pair', 'Promise'],
    body);
};

function fromAsyncGen(fn) {
  let { promise, resolve } = createDeferredPromise();
  const value = fn(async function*() {
    while (true) {
      const { chunk, done, cb } = await promise;
      process.nextTick(cb);
      if (done) return;
      yield chunk;
      ({ promise, resolve } = createDeferredPromise());
    }
  }());

  return {
    value,
    write(chunk, encoding, cb) {
      resolve({ chunk, done: false, cb });
    },
    final(cb) {
      resolve({ done: true, cb });
    }
  };
}

function _duplexify(pair) {
  const r = pair.readable && typeof pair.readable.read !== 'function' ?
    Readable.wrap(pair.readable) : pair.readable;
  const w = pair.writable;

  let readable = !!isReadable(r);
  let writable = !!isWritable(w);

  let ondrain;
  let onfinish;
  let onreadable;
  let onclose;
  let d;

  function onfinished(err) {
    const cb = onclose;
    onclose = null;

    if (cb) {
      cb(err);
    } else if (err) {
      d.destroy(err);
    } else if (!readable && !writable) {
      d.destroy();
    }
  }

  // TODO(ronag): Avoid double buffering.
  // Implement Writable/Readable/Duplex traits.
  // See, https://github.com/nodejs/node/pull/33515.
  d = new Duplexify({
    // TODO (ronag): highWaterMark?
    readableObjectMode: !!r?.readableObjectMode,
    writableObjectMode: !!w?.writableObjectMode,
    readable,
    writable,
  });

  if (writable) {
    eos(w, (err) => {
      writable = false;
      if (err) {
        destroyer(r, err);
      }
      onfinished(err);
    });

    d._write = function(chunk, encoding, callback) {
      if (w.write(chunk, encoding)) {
        callback();
      } else {
        ondrain = callback;
      }
    };

    d._final = function(callback) {
      w.end();
      onfinish = callback;
    };

    w.on('drain', function() {
      if (ondrain) {
        const cb = ondrain;
        ondrain = null;
        cb();
      }
    });

    w.on('finish', function() {
      if (onfinish) {
        const cb = onfinish;
        onfinish = null;
        cb();
      }
    });
  }

  if (readable) {
    eos(r, (err) => {
      readable = false;
      if (err) {
        destroyer(r, err);
      }
      onfinished(err);
    });

    r.on('readable', function() {
      if (onreadable) {
        const cb = onreadable;
        onreadable = null;
        cb();
      }
    });

    r.on('end', function() {
      d.push(null);
    });

    d._read = function() {
      while (true) {
        const buf = r.read();

        if (buf === null) {
          onreadable = d._read;
          return;
        }

        if (!d.push(buf)) {
          return;
        }
      }
    };
  }

  d._destroy = function(err, callback) {
    if (!err && onclose !== null) {
      err = new AbortError();
    }

    onreadable = null;
    ondrain = null;
    onfinish = null;

    if (onclose === null) {
      callback(err);
    } else {
      onclose = callback;
      destroyer(w, err);
      destroyer(r, err);
    }
  };

  return d;
}