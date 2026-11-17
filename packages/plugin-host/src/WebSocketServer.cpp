#include "WebSocketServer.h"

// ── SHA-1 (only for the handshake key) ─────────────────────────────────────────
static juce::MemoryBlock sha1 (const juce::String& text)
{
    auto msg = text.toStdString();
    uint32_t h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    std::vector<uint8_t> m (msg.begin(), msg.end());
    uint64_t bitLen = (uint64_t) m.size() * 8;
    m.push_back (0x80);
    while (m.size() % 64 != 56) m.push_back (0);
    for (int i = 7; i >= 0; --i) m.push_back ((uint8_t) (bitLen >> (i * 8)));
    auto rol = [] (uint32_t v, int n) { return (v << n) | (v >> (32 - n)); };
    for (size_t chunk = 0; chunk < m.size(); chunk += 64)
    {
        uint32_t w[80];
        for (int i = 0; i < 16; ++i)
            w[i] = (uint32_t) m[chunk + i * 4] << 24 | (uint32_t) m[chunk + i * 4 + 1] << 16 | (uint32_t) m[chunk + i * 4 + 2] << 8 | m[chunk + i * 4 + 3];
        for (int i = 16; i < 80; ++i) w[i] = rol (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
        for (int i = 0; i < 80; ++i)
        {
            uint32_t f, k;
            if (i < 20)      { f = (b & c) | (~b & d);           k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d;                    k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d);  k = 0x8F1BBCDC; }
            else             { f = b ^ c ^ d;                    k = 0xCA62C1D6; }
            uint32_t t = rol (a, 5) + f + e + k + w[i];
            e = d; d = c; c = rol (b, 30); b = a; a = t;
        }
        h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
    }
    uint8_t out[20];
    uint32_t hs[5] = { h0, h1, h2, h3, h4 };
    for (int i = 0; i < 5; ++i)
        for (int j = 0; j < 4; ++j) out[i * 4 + j] = (uint8_t) (hs[i] >> (24 - j * 8));
    return juce::MemoryBlock (out, 20);
}

// ── connection ─────────────────────────────────────────────────────────────────
bool WsConnection::readExactly (void* dst, int n)
{
    auto* p = static_cast<char*> (dst);
    while (n > 0)
    {
        int r = socket->read (p, n, true);
        if (r <= 0) return false;
        p += r; n -= r;
    }
    return true;
}

bool WsConnection::handshake()
{
    // read the HTTP request up to the empty line
    juce::String req;
    char c;
    while (! req.endsWith ("\r\n\r\n"))
    {
        if (! readExactly (&c, 1) || req.length() > 8192) return false;
        req += c;
    }
    juce::String key;
    for (auto& line : juce::StringArray::fromLines (req))
        if (line.startsWithIgnoreCase ("Sec-WebSocket-Key:"))
            key = line.fromFirstOccurrenceOf (":", false, false).trim();
    if (key.isEmpty()) return false;
    auto digest = sha1 (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    auto accept = juce::Base64::toBase64 (digest.getData(), digest.getSize());
    juce::String resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
    std::lock_guard<std::mutex> l (writeLock);
    return socket->write (resp.toRawUTF8(), (int) resp.getNumBytesAsUTF8()) > 0;
}

bool WsConnection::readFrame (int& opcode, juce::MemoryBlock& payload)
{
    // collects continuation frames into one message
    payload.reset();
    opcode = -1;
    for (;;)
    {
        uint8_t h[2];
        if (! readExactly (h, 2)) return false;
        bool fin = (h[0] & 0x80) != 0;
        int op = h[0] & 0x0F;
        bool masked = (h[1] & 0x80) != 0;
        uint64_t len = h[1] & 0x7F;
        if (len == 126) { uint8_t e[2]; if (! readExactly (e, 2)) return false; len = (uint64_t) e[0] << 8 | e[1]; }
        else if (len == 127) { uint8_t e[8]; if (! readExactly (e, 8)) return false; len = 0; for (int i = 0; i < 8; ++i) len = len << 8 | e[i]; }
        if (len > (uint64_t) 64 * 1024 * 1024) return false;
        uint8_t mask[4] = { 0, 0, 0, 0 };
        if (masked && ! readExactly (mask, 4)) return false;
        juce::MemoryBlock part ((size_t) len);
        if (len > 0 && ! readExactly (part.getData(), (int) len)) return false;
        auto* d = static_cast<uint8_t*> (part.getData());
        if (masked) for (uint64_t i = 0; i < len; ++i) d[i] ^= mask[i % 4];

        if (op == 0x8) return false;                                   // close
        if (op == 0x9) { writeFrame (0xA, part.getData(), part.getSize()); continue; }   // ping -> pong
        if (op == 0xA) continue;
        if (op != 0) opcode = op;
        payload.append (part.getData(), part.getSize());
        if (fin) return true;
    }
}

bool WsConnection::writeFrame (int opcode, const void* data, size_t size)
{
    if (! open) return false;
    std::lock_guard<std::mutex> l (writeLock);
    uint8_t h[10];
    int hl = 2;
    h[0] = (uint8_t) (0x80 | opcode);
    if (size < 126) h[1] = (uint8_t) size;
    else if (size < 65536) { h[1] = 126; h[2] = (uint8_t) (size >> 8); h[3] = (uint8_t) size; hl = 4; }
    else { h[1] = 127; for (int i = 0; i < 8; ++i) h[2 + i] = (uint8_t) ((uint64_t) size >> (56 - i * 8)); hl = 10; }
    if (socket->write (h, hl) != hl) { open = false; return false; }
    if (size > 0 && socket->write (data, (int) size) != (int) size) { open = false; return false; }
    return true;
}

bool WsConnection::sendText (const juce::String& text) { return writeFrame (0x1, text.toRawUTF8(), text.getNumBytesAsUTF8()); }
bool WsConnection::sendBinary (const void* data, size_t size) { return writeFrame (0x2, data, size); }
void WsConnection::close() { open = false; socket->close(); }

// ── server ─────────────────────────────────────────────────────────────────────
namespace
{
    class Reader : public juce::Thread
    {
    public:
        Reader (std::shared_ptr<WsConnection> c, WebSocketServer::Handler& h) : juce::Thread ("ws-conn"), conn (std::move (c)), handler (h) {}
        ~Reader() override { conn->close(); stopThread (2000); }
        void run() override
        {
            if (! conn->handshake()) { conn->close(); return; }
            int op; juce::MemoryBlock payload;
            while (! threadShouldExit() && conn->readFrame (op, payload))
            {
                if (op == 0x1) handler.onText (conn, payload.toString());
                else if (op == 0x2) handler.onBinary (conn, payload);
            }
            conn->close();
            handler.onClosed (conn);
        }
        std::shared_ptr<WsConnection> conn;
        WebSocketServer::Handler& handler;
    };
}

WebSocketServer::~WebSocketServer() { stop(); }

int WebSocketServer::start()
{
    for (int port = 0; port == 0;)
    {
        if (! listener.createListener (0, "127.0.0.1")) return 0;      // port 0: the system picks a free one
        port = listener.getBoundPort();
        if (port <= 0) return 0;
        startThread();
        return port;
    }
    return 0;
}

void WebSocketServer::stop()
{
    signalThreadShouldExit();
    listener.close();
    stopThread (2000);
    std::lock_guard<std::mutex> l (readersLock);
    readers.clear();
}

void WebSocketServer::run()
{
    while (! threadShouldExit())
    {
        std::unique_ptr<juce::StreamingSocket> s (listener.waitForNextConnection());
        if (s == nullptr) { if (threadShouldExit()) break; continue; }
        auto conn = std::make_shared<WsConnection> (std::move (s));
        std::lock_guard<std::mutex> l (readersLock);
        conn->id = nextId++;
        for (int i = readers.size(); --i >= 0;)                          // tidy up finished connections
            if (! readers[i]->isThreadRunning()) readers.remove (i);
        auto* r = new Reader (conn, handler);
        readers.add (r);
        r->startThread (juce::Thread::Priority::highest);
    }
}
