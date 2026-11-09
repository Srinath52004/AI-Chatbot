import { useEffect, useRef, useState } from 'react'

const suggestions = [
  { icon: '✳', title: 'Write something', detail: 'Draft an email, post, or story' },
  { icon: '⌘', title: 'Help me learn', detail: 'Make a tricky topic feel simple' },
  { icon: '↗', title: 'Plan a project', detail: 'Turn an idea into next steps' },
]

function Icon({ name, size = 18 }) {
  const paths = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" /></>,
    paperclip: <><path d="m21.4 11.1-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></>,
    sparkle: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 14 1.1 2.9L23 18l-2.9 1.1L19 22l-1.1-2.9L15 18l2.9-1.1L19 14Z" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
  }

  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  )
}

async function requestChatReply(messages, onChunk) {
  let csrfResponse
  try {
    csrfResponse = await fetch('/api/csrf/')
  } catch {
    throw new Error('Could not reach the chat server. Start the Django backend and try again.')
  }

  if (!csrfResponse.ok) {
    throw new Error('Could not prepare a secure chat request. Please try again.')
  }

  const { csrfToken } = await csrfResponse.json()
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 190_000)
  try {
    const response = await fetch('/api/chat/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrfToken,
      },
      body: JSON.stringify({ messages }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || 'The chat request failed. Please try again.')
    }

    if (!response.body) {
      throw new Error('The chat server did not start a response stream. Please try again.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let completed = false
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line)
        if (event.error) throw new Error(event.error)
        if (typeof event.text === 'string') onChunk(event.text)
        if (event.done) completed = true
      }

      if (done) break
    }

    if (buffer.trim()) {
      const event = JSON.parse(buffer)
      if (event.error) throw new Error(event.error)
      if (typeof event.text === 'string') onChunk(event.text)
      if (event.done) completed = true
    }
    if (!completed) throw new Error('The response stream ended unexpectedly. Please try again.')
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Gemini is taking too long to respond. Please try again.', { cause: error })
    }
    if (error instanceof SyntaxError) {
      throw new Error('The chat server returned an invalid response. Please try again.', { cause: error })
    }
    if (error instanceof TypeError) {
      throw new Error('Could not reach the chat server. Start the Django backend and try again.', { cause: error })
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function App() {
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sendingIds, setSendingIds] = useState(() => new Set())
  const endOfMessages = useRef(null)

  const activeConversation = conversations.find((conversation) => conversation.id === activeId)
  const messages = activeConversation?.messages ?? []
  const isSending = Boolean(activeId && sendingIds.has(activeId))
  const filteredConversations = conversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(search.toLowerCase()),
  )

  useEffect(() => {
    endOfMessages.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length])

  useEffect(() => {
    function handleNewChatShortcut(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setActiveId(null)
        setMessage('')
        setSidebarOpen(false)
      }
    }

    window.addEventListener('keydown', handleNewChatShortcut)
    return () => window.removeEventListener('keydown', handleNewChatShortcut)
  }, [])

  function startNewChat() {
    setActiveId(null)
    setMessage('')
    setSidebarOpen(false)
  }

  async function sendMessage(text = message) {
    const content = text.trim()
    const id = activeId ?? crypto.randomUUID()
    if (!content || sendingIds.has(id)) return

    const userMessage = { role: 'user', content }
    const history = [...messages.filter((item) => !item.isError), userMessage]

    setConversations((current) => {
      const existing = current.find((conversation) => conversation.id === id)
      if (existing) {
        return current.map((conversation) => conversation.id === id
          ? { ...conversation, messages: [...conversation.messages, userMessage] }
          : conversation)
      }
      return [{ id, title: content.slice(0, 32), messages: [userMessage] }, ...current]
    })
    setActiveId(id)
    setMessage('')
    setSidebarOpen(false)
    setSendingIds((current) => new Set(current).add(id))

    try {
      await requestChatReply(history, (chunk) => {
        setConversations((current) => current.map((conversation) => {
          if (conversation.id !== id) return conversation
          const lastMessage = conversation.messages.at(-1)
          if (lastMessage?.role === 'assistant' && !lastMessage.isError) {
            return {
              ...conversation,
              messages: [
                ...conversation.messages.slice(0, -1),
                { ...lastMessage, content: lastMessage.content + chunk },
              ],
            }
          }
          return {
            ...conversation,
            messages: [...conversation.messages, { role: 'assistant', content: chunk }],
          }
        }))
      })
    } catch (error) {
      setConversations((current) => current.map((conversation) => conversation.id === id
        ? {
            ...conversation,
            messages: [...conversation.messages, {
              role: 'assistant',
              content: error instanceof Error ? error.message : 'The chat request failed. Please try again.',
              isError: true,
            }],
          }
        : conversation))
    } finally {
      setSendingIds((current) => {
        if (!current.has(id)) return current
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  function handleComposerKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`}>
        <div className="sidebar-top">
          <a className="brand" href="#home" onClick={startNewChat} aria-label="Morrow home">
            <span className="brand-mark"><Icon name="sparkle" size={19} /></span>
            <span>morrow</span>
          </a>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">
            <Icon name="close" />
          </button>
        </div>

        <button className="new-chat-button" onClick={startNewChat}>
          <Icon name="plus" size={17} />
          <span>New conversation</span>
          <span className="shortcut">⌘ K</span>
        </button>

        <label className="search-box">
          <Icon name="search" size={16} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" />
        </label>

        <div className="history-heading">YOUR SPACE</div>
        <nav className="conversation-list" aria-label="Conversation history">
          {filteredConversations.length > 0 ? filteredConversations.map((conversation) => (
            <button
              className={`conversation-item${conversation.id === activeId ? ' conversation-active' : ''}`}
              key={conversation.id}
              onClick={() => { setActiveId(conversation.id); setSidebarOpen(false) }}
              title={conversation.title}
            >
              <span className="conversation-dot" />
              <span>{conversation.title}</span>
            </button>
          )) : (
            <p className="empty-history">{search ? 'No matches found.' : 'Your conversations will show up here.'}</p>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="profile-avatar">S</div>
          <div className="profile-copy"><strong>Sam</strong><span>Free account</span></div>
          <span className="profile-menu" aria-hidden="true">···</span>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}

      <main className="main-panel">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            <Icon name="menu" />
          </button>
          <div className="model-picker"><span className="model-indicator" /> Morrow <span className="model-version">v1</span></div>
          <div className="topbar-right"><span className="availability-dot" /> Here to help</div>
        </header>

        <section className={`chat-area${messages.length ? ' chat-area-active' : ''}`} aria-label="Chat">
          {messages.length === 0 ? (
            <div className="welcome-content">
              <div className="welcome-kicker"><span className="kicker-line" /> A LITTLE ROOM TO THINK <span className="kicker-line" /></div>
              <h1>Good ideas start<br />with <span>a conversation.</span></h1>
              <p className="welcome-description">A thoughtful helper for whatever’s on your mind.<br className="desktop-break" /> Where should we begin?</p>

              <div className="suggestion-grid">
                {suggestions.map((suggestion) => (
                  <button className="suggestion-card" key={suggestion.title} onClick={() => sendMessage(suggestion.title)}>
                    <span className="suggestion-icon">{suggestion.icon}</span>
                    <span className="suggestion-title">{suggestion.title}</span>
                    <span className="suggestion-detail">{suggestion.detail}</span>
                    <span className="suggestion-arrow" aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-thread">
              {messages.map((chatMessage, index) => (
                <article className={`message-row message-${chatMessage.role}`} key={`${activeId}-${index}`}>
                  {chatMessage.role === 'assistant' ? (
                    <span className="assistant-avatar"><Icon name="sparkle" size={16} /></span>
                  ) : <span className="user-avatar">S</span>}
                  <div className="message-body">
                    <div className="message-author">{chatMessage.role === 'assistant' ? 'Morrow' : 'You'}</div>
                    <p className={chatMessage.isError ? 'message-error' : undefined} role={chatMessage.isError ? 'alert' : undefined}>{chatMessage.content}</p>
                  </div>
                </article>
              ))}
              {isSending && (
                <article className="message-row message-assistant" aria-live="polite">
                  <span className="assistant-avatar"><Icon name="sparkle" size={16} /></span>
                  <div className="message-body">
                    <div className="message-author">Morrow</div>
                    <p className="thinking-text" role="status">
                      <span className="visually-hidden">Morrow is thinking</span>
                      <span className="thinking-indicator" aria-hidden="true"><span /><span /><span /></span>
                    </p>
                  </div>
                </article>
              )}
              <div ref={endOfMessages} />
            </div>
          )}
        </section>

        <div className="composer-dock">
          <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage() }}>
            <textarea
              aria-label="Message Morrow"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              disabled={isSending}
              placeholder="Ask anything, or just start with a thought..."
              rows="1"
            />
            <div className="composer-tools">
              <button className="icon-button attach-button" type="button" aria-label="Attach a file" title="Attachments aren’t available in this demo">
                <Icon name="paperclip" size={17} />
              </button>
              <span className="composer-hint">{isSending ? 'Morrow is thinking...' : <>Enter to send <span>·</span> Shift + Enter for a new line</>}</span>
              <button className="send-button" type="submit" disabled={!message.trim() || isSending} aria-label="Send message">
                <Icon name="send" size={16} />
              </button>
            </div>
          </form>
          <p className="disclaimer">Morrow uses Gemini. Double-check anything important.</p>
        </div>
      </main>
    </div>
  )
}

export default App