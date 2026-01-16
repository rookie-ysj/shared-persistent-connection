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

    console.log('SharedPersistentConnection constructor');
    navigator.locks.query()
      .then((state) => {
        console.log("所有锁的状态:", state);

        // 查看已持有的锁
        console.log("持有的锁:", state.held);

        // 查看正在等待的锁请求
        console.log("等待的锁:", state.pending);
      });
  }

  private abortConnection() {
    this.abortController && this.abortController.abort()
  }

  private launch() {
    if (!this.isLeader || this.state === ConnectionState.Closed) {
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
    this.state = ConnectionState.Closed
    this.releaseLock?.()
    this.abortConnection()
    this.channel.close()
  }
}
