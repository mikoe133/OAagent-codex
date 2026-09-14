import { readServerEnvValue } from "./server-env"

export function getAgentApiBaseUrl(): string {
  return readServerEnvValue("AGENT_API_BASE_URL") ||
    readServerEnvValue("AGENT_BASE_URL") ||
    readServerEnvValue("NEXT_PUBLIC_AGENT_API_BASE_URL") ||
    "http://127.0.0.1:3000"
}
