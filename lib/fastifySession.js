'use strict'

const fastifyPlugin = require('fastify-plugin')
const Store = require('./store')
const Session = require('./session')
const metadata = require('./metadata')
const cookieSignature = require('cookie-signature')
const generateSessionIds = require('./utils')

function session (fastify, options, next) {
  const error = checkOptions(options)
  if (error) return next(error)

  options = ensureDefaults(options)

  fastify.decorateRequest('sessionStore', options.store)
  fastify.decorateRequest('session', {})
  fastify.addHook('preHandler', preHandler(options))
  fastify.addHook('onSend', onSend(options))
  next()
}

function preHandler (options) {
  const cookieOpts = options.cookie
  const secret = options.secret
  return function handleSession (request, reply, done) {
    const url = request.req.url
    if (url.indexOf(cookieOpts.path || '/') !== 0) {
      done()
      return
    }
    let sessionId = request.cookies[options.cookieName]
    if (!sessionId) {
      newSession(secret, request, reply, done, cookieOpts)
    } else {
      const decryptedSessionId = cookieSignature.unsign(sessionId, secret)
      if (decryptedSessionId === false) {
        newSession(secret, request, reply, done, cookieOpts)
      } else {
        options.store.get(decryptedSessionId, (err, session) => {
          if (err) {
            if (err.code === 'ENOENT') {
              newSession(secret, request, reply, done, cookieOpts)
            } else {
              done(err)
            }
            return
          }
          if (!session) {
            newSession(secret, request, reply, done, cookieOpts)
            return
          }
          if (session && session.expires && session.expires <= Date.now()) {
            options.store.destroy(sessionId, getDestroyCallback(secret, request, reply, done, cookieOpts))
            return
          }
          request.session = new Session(
            session.sessionId,
            session.encryptedSessionId,
            cookieOpts,
            secret,
            session
          )
          done()
        })
      }
    }
  }
}

function onSend (options) {
  return function saveSession (request, reply, payload, done) {
    const session = request.session
    if (!session || !session.sessionId || !shouldSaveSession(request, options.cookie, options.saveUninitialized)) {
      done()
      return
    }
    options.store.set(session.sessionId, session, (err) => {
      if (err) {
        done(err)
        return
      }
      reply.setCookie(options.cookieName, session.encryptedSessionId, session.cookie)
      done()
    })
  }
}

function getDestroyCallback (secret, request, reply, done, cookieOpts) {
  return function destroyCallback (err) {
    if (err) {
      done(err)
      return
    }
    newSession(secret, request, reply, done, cookieOpts)
  }
}

function newSession (secret, request, reply, done, cookieOpts) {
  const sessionIds = generateSessionIds(secret)
  const session = new Session(sessionIds.sessionId, sessionIds.encryptedSessionId, cookieOpts, secret)
  request.session = session
  done()
}

function checkOptions (options) {
  if (!options.secret) {
    return new Error('the secret option is required!')
  }
  if (options.secret.length < 32) {
    return new Error('the secret must have length 32 or greater')
  }
}

function ensureDefaults (options) {
  options.store = options.store || new Store()
  options.cookieName = options.cookieName || 'sessionId'
  options.cookie = options.cookie || {}
  options.cookie.secure = option(options.cookie, 'secure', true)
  options.saveUninitialized = option(options, 'saveUninitialized', true)
  return options
}

function shouldSaveSession (request, cookieOpts, saveUninitialized) {
  if (!saveUninitialized && !isSessionModified(request.session)) {
    return false
  }
  if (cookieOpts.secure !== true) {
    return true
  }
  const connection = request.req.connection
  if (connection && connection.encrypted === true) {
    return true
  }
  const forwardedProto = request.headers['x-forwarded-proto']
  return forwardedProto === 'https'
}

function isSessionModified (session) {
  return (Object.keys(session).length !== 4)
}

function option (options, key, def) {
  return options[key] === undefined ? def : options[key]
}

exports = module.exports = fastifyPlugin(session, metadata)
module.exports.Store = Store
