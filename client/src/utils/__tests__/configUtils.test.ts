import {
  getMCPProxyAuthToken,
  getServerConfigUrl,
  getServerConfigUrlSource,
  redactUrlForLog,
} from "../configUtils";
import { DEFAULT_INSPECTOR_CONFIG } from "../../lib/constants";
import { InspectorConfig } from "../../lib/configurationTypes";

describe("configUtils", () => {
  describe("getMCPProxyAuthToken", () => {
    test("returns token and default header name", () => {
      const config: InspectorConfig = {
        ...DEFAULT_INSPECTOR_CONFIG,
        MCP_PROXY_AUTH_TOKEN: {
          ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_AUTH_TOKEN,
          value: "test-token-123",
        },
      };

      const result = getMCPProxyAuthToken(config);

      expect(result).toEqual({
        token: "test-token-123",
        header: "X-MCP-Proxy-Auth",
      });
    });

    test("returns empty token when not configured", () => {
      const config: InspectorConfig = {
        ...DEFAULT_INSPECTOR_CONFIG,
        MCP_PROXY_AUTH_TOKEN: {
          ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_AUTH_TOKEN,
          value: "",
        },
      };

      const result = getMCPProxyAuthToken(config);

      expect(result).toEqual({
        token: "",
        header: "X-MCP-Proxy-Auth",
      });
    });

    test("always returns X-MCP-Proxy-Auth as header name", () => {
      const config: InspectorConfig = {
        ...DEFAULT_INSPECTOR_CONFIG,
        MCP_PROXY_AUTH_TOKEN: {
          ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_AUTH_TOKEN,
          value: "any-token",
        },
      };

      const result = getMCPProxyAuthToken(config);

      expect(result.header).toBe("X-MCP-Proxy-Auth");
    });

    test("handles null/undefined value gracefully", () => {
      const config: InspectorConfig = {
        ...DEFAULT_INSPECTOR_CONFIG,
        MCP_PROXY_AUTH_TOKEN: {
          ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_AUTH_TOKEN,
          value: null as unknown as string,
        },
      };

      const result = getMCPProxyAuthToken(config);

      expect(result).toEqual({
        token: null,
        header: "X-MCP-Proxy-Auth",
      });
    });
  });

  describe("getServerConfigUrl", () => {
    test("returns url when present", () => {
      const config = {
        type: "streamable-http",
        url: "http://localhost:6277/mcp",
      };

      expect(getServerConfigUrl(config)).toBe("http://localhost:6277/mcp");
      expect(getServerConfigUrlSource(config)).toBe("url");
    });

    test("returns serverUrl when url is not present", () => {
      const config = {
        type: "streamable-http",
        serverUrl:
          "http://localhost:6277/mcp?credentialFile=credentials-find.json&credentialKey=datadog%7C0c936d4f10cfb825",
      };

      expect(getServerConfigUrl(config)).toBe(config.serverUrl);
      expect(getServerConfigUrlSource(config)).toBe("serverUrl");
    });

    test("falls back to sseUrl for legacy configs", () => {
      const config = {
        type: "sse",
        sseUrl: "http://localhost:3000/sse",
      };

      expect(getServerConfigUrl(config)).toBe("http://localhost:3000/sse");
      expect(getServerConfigUrlSource(config)).toBe("sseUrl");
    });

    test("returns an empty string when no supported URL field is present", () => {
      expect(getServerConfigUrl({ type: "streamable-http" })).toBe("");
      expect(getServerConfigUrlSource({ type: "streamable-http" })).toBeNull();
    });
  });

  describe("redactUrlForLog", () => {
    test("redacts query parameter values", () => {
      expect(
        redactUrlForLog(
          "http://localhost:6277/mcp?credentialFile=credentials-find.json&credentialKey=datadog%7Csecret",
        ),
      ).toBe(
        "http://localhost:6277/mcp?credentialFile=REDACTED&credentialKey=REDACTED",
      );
    });
  });
});
