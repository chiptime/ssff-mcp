/**
 * MCP prompts: reusable interaction templates for the read-only tools.
 *
 * Contract:
 * - A prompt only builds text. It never reads configuration, never contacts
 *   SuccessFactors and never embeds credentials, URLs or data; every read
 *   still goes through the tools and their policy checks.
 * - Arguments are validated before any text is produced: entity set names
 *   follow the OData grammar used elsewhere, environments are a single line
 *   and the free-text goal is bounded.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const MAX_GOAL_LENGTH = 1000;

const environmentArg = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\u0000-\u001f\u007f]+$/, "environment must be a single line without control characters")
  .optional()
  .describe("Environment alias. Omit it to let the assistant pick one with list_environments.");

const entitySetArg = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "entitySet must be an OData entity set name")
  .describe("Entity set to work with (e.g. 'EmpJob', 'cust_Equipo').");

const goalArg = z
  .string()
  .min(1)
  .max(MAX_GOAL_LENGTH)
  .describe("What the user wants to find out, in their own words.");

function userMessage(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

function environmentStep(environment: string | undefined): string {
  return environment === undefined
    ? "1. Call list_environments and ask me which environment to use if more than one is configured."
    : `1. Use environment "${environment}".`;
}

const READ_ONLY_RULE =
  "This server is read-only: never attempt to create, update or delete data, and never invent entity, field or navigation names.";

export function buildExploreEntityPrompt(args: { environment?: string; entitySet: string }): GetPromptResult {
  const resourceUri = args.environment === undefined
    ? `sf://<environment>/entities/${args.entitySet}`
    : `sf://${args.environment}/entities/${args.entitySet}`;
  return userMessage([
    `Help me understand the SuccessFactors entitySet "${args.entitySet}" before reading any data.`,
    "",
    environmentStep(args.environment),
    `2. Call inspect_entity with entitySet "${args.entitySet}" (or read the resource ${resourceUri}) to get its keys, typed properties and navigation properties.`,
    "3. Summarize: the key fields, the most useful properties, whether it is effective-dated, its navigations and, for Custom MDF objects, how it links to an employee and the suggested filter.",
    "4. Propose one or two small example reads with query_entity, but do not run them until I confirm.",
    "",
    READ_ONLY_RULE,
    "If the entity is not found or not allowed, say so instead of guessing.",
  ].join("\n"));
}

export function buildPrepareReadQueryPrompt(args: {
  environment?: string;
  entitySet: string;
  goal: string;
}): GetPromptResult {
  return userMessage([
    `Plan a bounded read of the SuccessFactors entitySet "${args.entitySet}" for this goal:`,
    "",
    args.goal,
    "",
    environmentStep(args.environment),
    `2. Call inspect_entity with entitySet "${args.entitySet}" first and use only properties and navigations it reports.`,
    "3. Draft one query_entity call: a filter on key or indexed fields, select with only the fields the goal needs, and a small top.",
    "4. If the entity is effective-dated, use asOfDate for a point in time or fromDate/toDate for a range (bare YYYY-MM-DD parameters, never inside the filter).",
    "5. Show me the exact arguments and wait for my confirmation before running it. If hasMore is returned, continue only with the cursor and the same arguments.",
    "",
    READ_ONLY_RULE,
  ].join("\n"));
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "explore_entity",
    {
      title: "Explore an entity schema",
      description: "Guides the assistant to inspect an entity's keys, properties and navigations before reading any data.",
      argsSchema: { environment: environmentArg, entitySet: entitySetArg },
    },
    (args) => buildExploreEntityPrompt(args),
  );

  server.registerPrompt(
    "prepare_read_query",
    {
      title: "Prepare a bounded read query",
      description:
        "Guides the assistant to plan one bounded query_entity call (filter, select, top, effective dating) for a stated goal and wait for confirmation.",
      argsSchema: { environment: environmentArg, entitySet: entitySetArg, goal: goalArg },
    },
    (args) => buildPrepareReadQueryPrompt(args),
  );
}
