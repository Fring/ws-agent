const express = require('express')
const bodyParser = require('body-parser')
const { omit, find, findIndex, filter, once } = require('lodash/fp')
const { body, param, query } = require('express-validator/check')
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
 * @param {number=10} numRetainMessages The number of messages to retain in memory. Defaults to 10.
 * @param {number=0} timeout The amount of time in milliseconds to keep the web socket up. Default of 0 means infinite
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
    body('url')
      .isURL({ protocol: ['ws', 'wss'] })
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
      .toInt()
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
      .withMessage('Id parameter must be an integer.')
      .toInt()
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
  '/websockets/:id/messages?pending&wait',
  [
    param('id')
      .isInt()
      .withMessage('Id parameter must be an integer.')
      .toInt(),
    query('pending')
      .optional()
      .isBoolean()
      .withMessage('Pending parameter is a boolean and can only take the form of 0 (default), 1, true, false.')
      .toBoolean(),
    query('wait')
      .optional()
      .isInt({ min: 0, max: 60 })
      .withMessage('Wait has to be a number of seconds from 0 (default) to 60.')
      .toInt()
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

    const sendMessages = once(messages => {
      messages.forEach(message => {
        message.read = true
      })
      res.status(200).json({
        messages
      })
    })

    if (req.query.pending) {
      let pendingMessages = filter(connection.messages, { read: false })
      if (pendingMessages) {
        sendMessages(pendingMessages)
      } else if (req.query.wait > 0) {
        let timeout
        timeout = setTimeout(function () {
          // Send what we have. This might be an empty array.
          sendMessages(pendingMessages)
        }, req.query.wait * 1000)

        emitter.once(`message:${req.params.id}`, function () {
          // We got a new event, clear the timeout and send new pending messages.
          clearTimeout(timeout)

          pendingMessages = filter(connection.messages, { read: false })
          sendMessages(pendingMessages)
        })
      }
    } else {
      sendMessages(connection.messages)
    }
  }
)

app.post(
  '/websockets/:id/messages',
  [
    param('id')
      .isInt()
      .withMessage('Id parameter must be an integer.')
      .toInt(),
    body().withMessage('A body is required with this request')
  ],
  (req, res) => {
    const connection = find({ id: req.params.id }, connections)
    if (connection) {
      connection.addMessage(MessageType.OUTGOING, req.body)
      res.status(201)
    } else {
      debug(`Connection with id "${req.params.id}" not found.`)
      res.status(404).json({
        error: `Connection with id "${req.params.id}" not found.`
      })
    }
  }
)

app.listen(port, () => console.log(`ws-agent is listening on port ${port}!`))
