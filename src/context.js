import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request facts every layer may need without threading them through each call: who is asking ('app', or
// 'mcp' for Claude/ChatGPT through Lumina's MCP servers) and an approval id sent with the request.
export const requestContext = new AsyncLocalStorage();
export const currentRequest = () => requestContext.getStore() ?? {};
