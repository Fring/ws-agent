const express = require('express')
const bodyParser = require('body-parser')
const { omit, find, findIndex, filter, once } = require('lodash/fp')
const { debounce } = require('lodash')
const { body, header, param, query, validationResult } = require('express-validator/check')
const dush = require('dush')
const WebSocket = require('ws')
const yargs = require('yargs')
const debug = require('debug')('ws-bridge')

yargs.usage('$0 [port]', 'Starts the WebSocket agent', yargs => {
  yargs.positional('port', {
    describe: 'Port to bind on',
    default: 3000
  })
})

const port = yargs.argv.port

const app = express()

app.use(bodyParser.json()) // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true })) // for parsing application/x-www-form-urlencoded
app.use(bodyParser.text()) // for parsing application/x-www-form-urlencoded

// Middleware for validating parameters
function validate (req, res, next) {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() })
  }
  next()
}

const connections = []
let connectionId = 0
let messageSequence = 0
const emitter = dush()

const Status = {
  PENDING: 'PENDING',
  CONNECTED: 'CONNECTED',
  ERROR: 'ERROR',
  DISCONNECTED: 'DISCONNECTED'
}

const MessageType = {
  INCOMING: 'INCOMING',
  OUTGOING: 'OUTGOING',
  STATUS: 'STATUS'
}

function createMessage (type, message, { connectionId, status = Status.CONNECTED }) {
  return {
    connectionId,
    seq: messageSequence++,
    type,
    message,
    status,
    read: false,
    timestamp: Date.now()
  }
}

/**
 * Function that takes a connection info, and returns a sanitized version that
 * includes only the metadata information of the connection.
 */
const getConnectionMetadata = omit(['ws', 'messages', 'addMessage'])

/**
 * @typedef {Object} PostWebSocketsBody
 * @param {string} url The url to connect to.
 * @param {number} [numRetainMessages=100] The number of messages to retain in memory. Defaults to 10.
 */

app.get('/websockets', (req, res) => {
  res.status(200).json({
    connections: connections.map(getConnectionMetadata)
  })
})

/**
 * Connection creation
 *
 * @param {PostWebSocketsBody} body
 */
app.post(
  '/websockets',
  [
    header('Content-Type')
      .equals('application/json')
      .withMessage('Can only accept Content-Type of application/json'),
    body('url')
      .isURL({ protocols: ['wss', 'ws'] })
      .withMessage('Must be a valid WebSocket URL'),
    body('numRetainMessages')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Must be a valid number greater or equal to 0 representing the number of messages to retain')
      .toInt(),
    body('timeout')
      .optional()
      .isInt({ min: 0 })
      .withMessage(
        'Must be a valid number greater or equal to 0 representing the number of milliseconds go keep the WebSocket alive'
      )
      .toInt(),
    validate
  ],
  (req, res) => {
    const connectionInfo = {
      id: connectionId++,
      ws: new WebSocket(req.body.url),
      status: Status.PENDING,
      messages: [],
      addMessage (type, message) {
        const msg = createMessage(type, message, this)
        this.messages.push(msg)
        debug(`New Message: ${msg}`)
        emitter.emit(`message:${this.id}`, { connectionId: this.id, message: msg })
      }
    }
    connections.push(connectionInfo)

    emitter.once(`message:${connectionInfo.id}`, function ({ message }) {
      let status = 500
      if (message.status === Status.CONNECTED) {
        status = 200
      }

      res.status(status).json(getConnectionMetadata(connectionInfo))
    })

    const { ws } = connectionInfo

    ws.on('open', function wsOpen () {
      connectionInfo.status = Status.CONNECTED
      connectionInfo.addMessage(MessageType.STATUS, 'WebSocket Connected')
    })

    ws.on('error', function wsError (error) {
      connectionInfo.status = Status.ERROR
      connectionInfo.statusCode = 500
      connectionInfo.statusMessage = error.message
      connectionInfo.addMessage(MessageType.STATUS, error.message)
    })

    ws.on('close', function wsClose (code, reason) {
      connectionInfo.status = Status.DISCONNECTED
      connectionInfo.statusCode = code
      connectionInfo.statusMessage = reason
      connectionInfo.addMessage(MessageType.STATUS, reason)
    })

    ws.on('message', function wsMessage (data) {
      connectionInfo.addMessage(MessageType.INCOMING, data)
    })
  }
)

app.delete(
  '/websockets/:id',
  [
    param('id')
      .isInt()
      .withMessage('id parameter must be an integer.')
      .toInt(),
    validate
  ],
  (req, res) => {
    const index = findIndex({ id: req.params.id }, connections)
    if (index !== -1) {
      // Pre-emptively remove the connection from the collection that way if something goes wrong we still
      // don't have it show up.
      const [removedItem] = connections.splice(index, 1)
      removedItem.status = res.status(200).send({ id: removedItem.id, status: Status.DISCONNECTED })
    } else {
      debug(`Connection with id "${req.params.id}" not found.`)
      res.status(404).json({
        error: `Connection with id "${req.params.id}" not found.`
      })
    }
  }
)

app.get(
  '/websockets/:id/messages',
  [
    param('id')
      .isInt()
      .withMessage('id parameter must be an integer.')
      .toInt(),
    query('pending')
      .optional()
      .isBoolean()
      .withMessage('pending parameter is a boolean and can only take the form of 0 (default), 1, true, false.')
      .toBoolean(),
    query('wait')
      .optional()
      .isInt({ min: 0, max: 60 })
      .withMessage('wait has to be a number of seconds from 0 (default) to 60.')
      .toInt(),
    query('debounce')
      .optional()
      .isInt({ min: 0 })
      .withMessage('debounce has to be a number of milliseconds greater than 0 (default)')
      .toInt(),
    query('debounceMax')
      .optional()
      .isInt({ min: 0 })
      .withMessage('debounceMax has to be a number of milliseconds greater than 0 (default)')
      .toInt(),
    validate
  ],
  (req, res) => {
    const connection = find({ id: req.params.id }, connections)
    if (!connection) {
      debug(`Connection with id "${req.params.id}" not found.`)
      res.status(404).json({
        error: `Connection with id "${req.params.id}" not found.`
      })
      return
    }

    const sendPendingMessages = once(() => {
      const pendingMessages = filter({ read: false }, connection.messages)
      pendingMessages.forEach(message => {
        message.read = true
      })
      res.status(200).json({
        messages: pendingMessages
      })
    })

    if (req.query.pending) {
      let pendingMessages = filter({ read: false }, connection.messages)
      if ((!pendingMessages.length && req.query.wait > 0) || req.query.debounce > 0) {
        let timeout

        const eventHandler = debounce(
          function () {
            clearTimeout(timeout)
            emitter.off(`message:${req.params.id}`, eventHandler)
            sendPendingMessages()
          },
          req.query.debounce || 0,
          {
            maxWait: req.query.debounceMax
          }
        )

        const wait =
          pendingMessages.length > 0 ? req.query.debounce || 0 : Math.max(req.query.wait * 1000, req.query.debounce)

        timeout = setTimeout(function () {
          // Cancel the debounce handler.
          eventHandler.cancel()

          // Send what we have. This might be an empty array.
          sendPendingMessages()
        }, wait)

        emitter.on(`message:${req.params.id}`, eventHandler)
      } else {
        sendPendingMessages()
      }
    } else {
      sendPendingMessages()
    }
  }
)

app.post(
  '/websockets/:id/messages',
  [
    header('Content-Type')
      .equals('text/plain')
      .withMessage('Can only accept Content-Type of text/plain'),
    param('id')
      .isInt()
      .withMessage('id parameter must be an integer.')
      .toInt(),
    body().withMessage('A body is required with this request'),
    validate
  ],
  (req, res) => {
    const connection = find({ id: req.params.id }, connections)
    if (connection) {
      connection.addMessage(MessageType.OUTGOING, req.body)
      connection.ws.send(req.body)
      res.status(201).end()
    } else {
      debug(`Connection with id "${req.params.id}" not found.`)
      res.status(404).json({
        error: `Connection with id "${req.params.id}" not found.`
      })
    }
  }
)

app.listen(port, () => console.log(`ws-agent is listening on port ${port}!`))
