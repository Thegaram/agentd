import { z } from "zod/v4";

export const SessionStateSchema = z.object({
  label: z.string(),
  agent: z.string().default("claude"),
  model: z.string().optional(),
  theme: z.string().optional(),
  containerId: z.string(),
  startedAt: z.iso.datetime(),
  autoRemove: z.boolean().default(false),
  credential: z.string().optional(),
  secrets: z.array(z.string()).default([]),
  mounts: z.array(z.string()).default([]),
  ports: z.array(z.string()).default([]),
  resolvedPorts: z.array(z.string()).default([]),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const StateFileSchema = z.object({
  sessions: z.array(SessionStateSchema).default([]),
});
export type StateFile = z.infer<typeof StateFileSchema>;
