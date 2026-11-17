#pragma once
// A small WebSocket server (RFC 6455) on 127.0.0.1 only: enough for the app to send JSON commands (text frames)
// and audio blocks (binary frames) to the host. One thread per connection; replies go back on the same connection.
#include <juce_core/juce_core.h>
#include <functional>
#include <memory>
#include <mutex>

class WsConnection
{
public:
    explicit WsConnection (std::unique_ptr<juce::StreamingSocket> s) : socket (std::move (s)) {}
    bool sendText (const juce::String& text);
    bool sendBinary (const void* data, size_t size);
    void close();
    bool isOpen() const { return open; }
    int id = 0;
    bool authed = false;

    // used by the server's reader thread
    bool handshake();
    bool readFrame (int& opcode, juce::MemoryBlock& payload);

private:
    bool readExactly (void* dst, int n);
    bool writeFrame (int opcode, const void* data, size_t size);
    std::unique_ptr<juce::StreamingSocket> socket;
    std::mutex writeLock;
    std::atomic<bool> open { true };
};

class WebSocketServer : private juce::Thread
{
public:
    struct Handler
    {
        virtual ~Handler() = default;
        virtual void onText (std::shared_ptr<WsConnection>, const juce::String&) = 0;
        virtual void onBinary (std::shared_ptr<WsConnection>, const juce::MemoryBlock&) = 0;
        virtual void onClosed (std::shared_ptr<WsConnection>) {}
    };

    explicit WebSocketServer (Handler& h) : juce::Thread ("ws-accept"), handler (h) {}
    ~WebSocketServer() override;
    int start();          // returns the port, 0 on failure
    void stop();

private:
    void run() override;
    Handler& handler;
    juce::StreamingSocket listener;
    juce::OwnedArray<juce::Thread> readers;
    std::mutex readersLock;
    int nextId = 1;
};
