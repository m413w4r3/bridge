"""server.py must stay a thin launcher; the composition root is bridge.app.BridgeApplication."""


class TestServerIsAThinLauncher:
    def test_server_py_is_a_thin_launcher(self):
        import server

        assert server.app is server.bridge_application.app
        assert server.bridge_application.bridge is not None
        assert server.bridge_application.registry is not None
        assert server.bridge_application.openai_routes is not None
        assert server.bridge_application.bridge_routes is not None
        assert server.bridge_application.conversation_routes is not None
