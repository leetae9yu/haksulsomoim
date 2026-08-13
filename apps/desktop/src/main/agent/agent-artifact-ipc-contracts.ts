import { z } from "zod";
import {
  agentArtifactIdSchema,
  agentRunIdSchema,
  caseIdSchema,
  contextDigestSchema,
  koreanLawCitationIdSchema,
} from "./agent-contracts-core";

export const agentArtifactOpenRequestSchema = z.strictObject({
  caseId: caseIdSchema,
  runId: agentRunIdSchema,
  contextDigest: contextDigestSchema,
  artifactId: agentArtifactIdSchema,
});

const artifactSectionSchema = z.strictObject({
  heading: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(4_000),
});
export const agentArtifactViewSchema = z
  .strictObject({
    artifactId: agentArtifactIdSchema,
    artifactKind: z.enum(["civil-demand", "criminal-complaint"]),
    title: z.string().trim().min(1).max(160),
    sections: z.array(artifactSectionSchema).min(1).max(8).readonly(),
    citationIds: z.array(koreanLawCitationIdSchema).min(1).max(24).readonly(),
  })
  .superRefine((artifact, context) => {
    if (new Set(artifact.citationIds).size !== artifact.citationIds.length) {
      context.addIssue({ code: "custom", message: "Artifact citation IDs must be unique" });
    }
  });

export type AgentArtifactOpenRequest = z.input<typeof agentArtifactOpenRequestSchema>;
export type AgentArtifactView = z.infer<typeof agentArtifactViewSchema>;
