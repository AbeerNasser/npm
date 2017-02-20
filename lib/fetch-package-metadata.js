'use strict'
var fs = require('graceful-fs')
var path = require('path')
var zlib = require('zlib')

var log = require('npmlog')
var realizePackageSpecifier = require('realize-package-specifier')
var tar = require('tar')
var once = require('once')
var readPackageTree = require('read-package-tree')
var readPackageJson = require('read-package-json')
var iferr = require('iferr')
var rimraf = require('rimraf')
var clone = require('lodash.clonedeep')
var validate = require('aproba')
var unpipe = require('unpipe')
var normalizePackageData = require('normalize-package-data')

var npm = require('./npm.js')
var cache = require('./cache.js')
var cachedPackageRoot = require('./cache/cached-package-root.js')
var tempFilename = require('./utils/temp-filename.js')
var parseJSON = require('./utils/parse-json.js')

var pacote = require('pacote')

function andLogAndFinish (spec, tracker, done) {
  validate('SF', [spec, done])
  return function (er, pkg) {
    if (er) {
      log.silly('fetchPackageMetaData', 'error for ' + spec, er)
      if (tracker) tracker.finish()
    }
    return done(er, pkg)
  }
}

module.exports = function fetchPackageMetadata (spec, where, tracker, done) {
  if (!done) {
    done = tracker || where
    tracker = null
    if (done === where) where = null
  }
  if (typeof spec === 'object') {
    var dep = spec
    spec = dep.raw
  }
  var logAndFinish = andLogAndFinish(spec, tracker, done)
  if (!dep) {
    log.silly('fetchPackageMetaData', spec)
    return realizePackageSpecifier(spec, where, iferr(logAndFinish, function (dep) {
      fetchPackageMetadata(dep, where, tracker, done)
    }))
  }
  if (dep.type === 'version' || dep.type === 'range' || dep.type === 'tag') {
    pacote.manifest(dep.raw, {
      // TODO - there's a *bunch* of other options that should
      //        be added here that pacote already supports.
      registry: npm.config.get('registry'),
      log: log,
      offline: npm.config.get('offline'),
      preferOffline: npm.config.get('prefer-offline'),
      cache: path.join(npm.config.get('cache'), '.pacote')
    }, function (err, pkg) {
      if (pkg) {
        // TODO - pacote makes these immutable. We should stop
        //        adding so many extra things to pkg itself.
        pkg = clone(pkg)
        // TODO - get rid of _from -- pacote won't add it.
        pkg._from = pkg._from || dep.raw
        pkg._inCache = true
      }
      addRequestedAndFinish(err, pkg)
    })
  } else if (dep.type === 'directory') {
    fetchDirectoryPackageData(dep, where, addRequestedAndFinish)
  } else {
    fetchOtherPackageData(spec, dep, where, addRequestedAndFinish)
  }
  function addRequestedAndFinish (er, pkg) {
    if (pkg) annotateMetadata(pkg, dep, spec, where)
    logAndFinish(er, pkg)
  }
}

var annotateMetadata = module.exports.annotateMetadata = function (pkg, requested, spec, where) {
  validate('OOSS', arguments)
  pkg._requested = requested
  pkg._spec = spec
  pkg._where = where
  if (!pkg._args) pkg._args = []
  pkg._args.push([requested, where])
  // non-npm registries can and will return unnormalized data, plus
  // even the npm registry may have package data normalized with older
  // normalization rules. This ensures we get package data in a consistent,
  // stable format.
  try {
    normalizePackageData(pkg)
  } catch (ex) {
    // don't care
  }
}

function fetchOtherPackageData (spec, dep, where, next) {
  validate('SOSF', arguments)
  log.silly('fetchOtherPackageData', spec)
  cache.add(spec, null, where, false, iferr(next, function (pkg) {
    var result = clone(pkg)
    result._inCache = true
    next(null, result)
  }))
}

function fetchDirectoryPackageData (dep, where, next) {
  validate('OSF', arguments)
  log.silly('fetchDirectoryPackageData', dep.name || dep.rawSpec)
  readPackageJson(path.join(dep.spec, 'package.json'), false, next)
}

function retryWithCached (pkg, asserter, next) {
  if (!pkg._inCache) {
    cache.add(pkg._spec, null, pkg._where, false, iferr(next, function (newpkg) {
      Object.keys(newpkg).forEach(function (key) {
        if (key[0] !== '_') return
        pkg[key] = newpkg[key]
      })
      pkg._inCache = true
      return asserter(pkg, next)
    }))
  }
  return !pkg._inCache
}

module.exports.addShrinkwrap = function addShrinkwrap (pkg, next) {
  validate('OF', arguments)
  if (pkg._hasShrinkwrap === false || pkg._shrinkwrap !== undefined) return next(null, pkg)
  if (retryWithCached(pkg, addShrinkwrap, next)) return
  pkg._shrinkwrap = null
  // FIXME: cache the shrinkwrap directly
  var pkgname = pkg.name
  var ver = pkg.version
  var tarball = path.join(cachedPackageRoot({name: pkgname, version: ver}), 'package.tgz')
  untarStream(tarball, function (er, untar) {
    if (er) {
      if (er.code === 'ENOTTARBALL') {
        pkg._shrinkwrap = null
        return next()
      } else {
        return next(er)
      }
    }
    if (er) return next(er)
    var foundShrinkwrap = false
    untar.on('entry', function (entry) {
      if (!/^(?:[^\/]+[\/])npm-shrinkwrap.json$/.test(entry.path)) return
      log.silly('addShrinkwrap', 'Found shrinkwrap in ' + pkgname + ' ' + entry.path)
      foundShrinkwrap = true
      var shrinkwrap = ''
      entry.on('data', function (chunk) {
        shrinkwrap += chunk
      })
      entry.on('end', function () {
        untar.close()
        log.silly('addShrinkwrap', 'Completed reading shrinkwrap in ' + pkgname)
        try {
          pkg._shrinkwrap = parseJSON(shrinkwrap)
        } catch (ex) {
          var er = new Error('Error parsing ' + pkgname + '@' + ver + "'s npm-shrinkwrap.json: " + ex.message)
          er.type = 'ESHRINKWRAP'
          return next(er)
        }
        next(null, pkg)
      })
      entry.resume()
    })
    untar.on('end', function () {
      if (!foundShrinkwrap) {
        pkg._shrinkwrap = null
        next(null, pkg)
      }
    })
  })
}

module.exports.addBundled = function addBundled (pkg, next) {
  validate('OF', arguments)
  if (pkg._bundled !== undefined) return next(null, pkg)
  if (!pkg.bundleDependencies) return next(null, pkg)
  if (retryWithCached(pkg, addBundled, next)) return
  pkg._bundled = null
  var pkgname = pkg.name
  var ver = pkg.version
  var target = tempFilename('unpack')
  pacote.extract(pkgname + '@' + ver, target, {
    cache: path.join(npm.config.get('cache'), '.pacote'),
    log: log,
    offline: npm.config.get('offline'),
    preferOffline: npm.config.get('prefer-offline')
  }, iferr(next, function () {
    log.silly('addBundled', 'read tarball')
    readPackageTree(target, function (er, tree) {
      log.silly('cleanup', 'remove extracted module')
      rimraf(target, function () {
        if (tree) {
          pkg._bundled = tree.children
        }
        next(null, pkg)
      })
    })
  }))
}

// FIXME: hasGzipHeader / hasTarHeader / untarStream duplicate a lot
// of code from lib/utils/tar.js– these should be brought together.

function hasGzipHeader (c) {
  return c[0] === 0x1F && c[1] === 0x8B && c[2] === 0x08
}

function hasTarHeader (c) {
  return c[257] === 0x75 && // tar archives have 7573746172 at position
         c[258] === 0x73 && // 257 and 003030 or 202000 at position 262
         c[259] === 0x74 &&
         c[260] === 0x61 &&
         c[261] === 0x72 &&

       ((c[262] === 0x00 &&
         c[263] === 0x30 &&
         c[264] === 0x30) ||

        (c[262] === 0x20 &&
         c[263] === 0x20 &&
         c[264] === 0x00))
}

function untarStream (tarball, cb) {
  validate('SF', arguments)
  cb = once(cb)

  var stream
  var file = stream = fs.createReadStream(tarball)
  var tounpipe = [file]
  file.on('error', function (er) {
    er = new Error('Error extracting ' + tarball + ' archive: ' + er.message)
    er.code = 'EREADFILE'
    cb(er)
  })
  file.on('data', function OD (c) {
    if (hasGzipHeader(c)) {
      doGunzip()
    } else if (hasTarHeader(c)) {
      doUntar()
    } else {
      if (file.close) file.close()
      if (file.destroy) file.destroy()
      var er = new Error('Non-gzip/tarball ' + tarball)
      er.code = 'ENOTTARBALL'
      return cb(er)
    }
    file.removeListener('data', OD)
    file.emit('data', c)
    cb(null, stream)
  })

  function doGunzip () {
    var gunzip = stream.pipe(zlib.createGunzip())
    gunzip.on('error', function (er) {
      er = new Error('Error extracting ' + tarball + ' archive: ' + er.message)
      er.code = 'EGUNZIP'
      cb(er)
    })
    tounpipe.push(gunzip)
    stream = gunzip
    doUntar()
  }

  function doUntar () {
    var untar = stream.pipe(tar.Parse())
    untar.on('error', function (er) {
      er = new Error('Error extracting ' + tarball + ' archive: ' + er.message)
      er.code = 'EUNTAR'
      cb(er)
    })
    tounpipe.push(untar)
    stream = untar
    addClose()
  }

  function addClose () {
    stream.close = function () {
      tounpipe.forEach(function (stream) {
        unpipe(stream)
      })

      if (file.close) file.close()
      if (file.destroy) file.destroy()
    }
  }
}
