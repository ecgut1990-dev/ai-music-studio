// AMS Plugin Host. Started by AI Music Studio only while a plugin is in use.
//   ams-plugin-host                          server: prints "AMS_PLUGIN_HOST_PORT <port>"; token in AMS_HOST_TOKEN
//   ams-plugin-host --scan-one <format> <file>   describes the plugins in one file (used by the search)
// The server quits when its standard input closes (the app is gone), so no host is left running.
#include "PluginHost.h"
#include <iostream>

class StdinWatch : public juce::Thread
{
public:
    StdinWatch() : juce::Thread ("stdin") {}
    void run() override
    {
        std::string line;
        while (! threadShouldExit() && std::getline (std::cin, line)) {}
        juce::MessageManager::callAsync ([] { juce::JUCEApplicationBase::quit(); });
    }
};

class HostApp : public juce::JUCEApplicationBase
{
public:
    const juce::String getApplicationName() override { return "ams-plugin-host"; }
    const juce::String getApplicationVersion() override { return JUCE_APPLICATION_VERSION_STRING; }
    bool moreThanOneInstanceAllowed() override { return true; }
    void anotherInstanceStarted (const juce::String&) override {}
    void suspended() override {}
    void resumed() override {}
    void systemRequestedQuit() override { quit(); }
    void unhandledException (const std::exception*, const juce::String&, int) override {}

    void initialise (const juce::String&) override
    {
        auto args = juce::JUCEApplicationBase::getCommandLineParameterArray();
        if (args.size() >= 3 && args[0] == "--scan-one")
        {
            int code = PluginHost::scanOne (args[1], args[2]);
            std::cout.flush();
            setApplicationReturnValue (code);
            quit();
            return;
        }
        auto token = juce::SystemStats::getEnvironmentVariable ("AMS_HOST_TOKEN", {});
        if (token.isEmpty()) { std::cerr << "AMS_HOST_TOKEN missing" << std::endl; setApplicationReturnValue (1); quit(); return; }
        host = std::make_unique<PluginHost> (token);
        server = std::make_unique<WebSocketServer> (*host);
        int port = server->start();
        if (port <= 0) { std::cerr << "no port" << std::endl; setApplicationReturnValue (1); quit(); return; }
        std::cout << "AMS_PLUGIN_HOST_PORT " << port << std::endl;
        if (! args.contains ("--no-stdin-watch")) { watch = std::make_unique<StdinWatch>(); watch->startThread(); }
    }

    void shutdown() override
    {
        if (server) server->stop();
        server.reset();
        host.reset();
        if (watch) watch->stopThread (100);
    }

private:
    std::unique_ptr<PluginHost> host;
    std::unique_ptr<WebSocketServer> server;
    std::unique_ptr<StdinWatch> watch;
};

START_JUCE_APPLICATION (HostApp)
