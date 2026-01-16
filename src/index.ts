import { fetchEventSource, type EventSourceMessage, type FetchEventSourceInit } from "@microsoft/fetch-event-source";

function getSelfKey(key: string, type: string) {
  return `shared-persistent-connection:${key}:${type}`
}

type FetchEventSourceInitConfig = FetchEventSourceInit & {
  retryWhenError?: boolean
}

enum ConnectionState {
  Closed = 'closed',
  Connecting = 'connecting',
  Open = 'open',
}

const instances = new Map<string, SharedPersistentConnection>()

export class SharedPersistentConnection {
  private isLeader: boolean = false
  private releaseLock: (() => void) | null = null
  private channel: BroadcastChannel
  private state: ConnectionState
  private abortController: AbortController | null = null

  constructor(
    public readonly url: string,
    public readonly config: FetchEventSourceInitConfig = {}
  ) {
    if (!navigator.locks || !window.BroadcastChannel) {
      throw new Error('SharedPersistentConnection is not supported in this browser')
    }

    if (instances.has(url)) {
      console.warn(
        `[SharedPersistentConnection] Duplicate connection for url "${url}".
          Only one instance per page is allowed.
          Drop the old instance.
          `
      )
      instances.get(url)!.close()
    }
    instances.set(url, this)

    this.channel = new BroadcastChannel(getSelfKey(this.url, 'channel'))

    this.channel.onmessage = (ev: MessageEvent<EventSourceMessage>) => {
      this.config.onmessage?.(ev.data)
    }

    this.state = ConnectionState.Connecting
    this.attemptToBeLeader()
  }

  private abortConnection() {
    this.abortController && this.abortController.abort()
    this.abortController = null
  }

  private launch() {
    if (!this.isLeader) {
      return
    }
    this.abortConnection()
    this.abortController = new AbortController()
    try {
      fetchEventSource(this.url, {
        ...this.config,
        signal: this.abortController.signal,
        onmessage: (event) => {
          this.config.onmessage?.(event)
          this.channel.postMessage(event)
        },
        onopen: (response) => {
          this.state = ConnectionState.Open
          if (this.config.onopen) {
            return this.config.onopen?.(response)
          }
          return Promise.resolve()
        },
        onclose: () => {
          this.config.onclose?.()
          this.close()
        },
        onerror: (err) => {
          this.config.onerror?.(err)
        }
      })
    } catch (e) {
      this.config.onerror?.(e)
    }
  }

  private attemptToBeLeader() {
    const lockKey = getSelfKey(this.url, 'lock')
    navigator.locks.request(lockKey, async () => {
      this.isLeader = true
      this.launch()

      await new Promise<void>(resolve => {
        this.releaseLock = resolve
      })

      this.isLeader = false
    })
  }

  public close() {
    if (this.state === ConnectionState.Closed) {
      return
    }
    this.releaseLock?.()
    this.channel.close()
    this.state = ConnectionState.Closed
  }
}
