/**
 * @fileoverview Zod shapes for what the Test Management routes hand back.
 *
 * A drift check, not a gate, like the calendar shapes: every schema is loose and names only the
 * fields that identify the row, so a new column never trips it. What it catches is a service
 * quietly changing a shape the screens depend on.
 * @module src/test-management/dto/test-management-response.schemas
 */

import { z } from 'zod';

const count = z.record(z.string(), z.number());

// Lists of ids (set test-ids, task type ids)
const idOrName = z.string();

// Every paged or listed reply: cases, sets, set members, case history
const listResponse = z.looseObject({ items: z.array(z.unknown()) });

// A case or a set
const keyedResponse = z.looseObject({ id: z.string(), key: z.string() });

// A folder
const namedResponse = z.looseObject({ id: z.string(), name: z.string() });

const settingsResponse = z.looseObject({
  assignee_only: z.boolean(),
  coverable_task_type_ids: z.array(z.string()),
  requirement_link_task_type_ids: z.array(z.string()),
  // Custom image approval, once its columns exist.
  image_approval_required: z.boolean().optional(),
  image_approval_rule: z.enum(['any', 'all']).optional(),
  image_approval_approvers: z.enum(['owners', 'owners_admins']).optional(),
  image_approval_has_owners: z.boolean().optional(),
});

const statusResponse = z.looseObject({
  code: z.string(),
  applies_to_run: z.boolean(),
});

const caseSavedResponse = z.looseObject({
  changed: z.boolean(),
  revision: z.number(),
  case: z.looseObject({ id: z.string() }),
});

const planTestResponse = z.looseObject({
  case_id: z.string(),
  key: z.string(),
});

const deleteResponse = z.looseObject({ counts: count });

const planDeletedResponse = z.looseObject({ executions_detached: z.number() });

const progressResponse = z.looseObject({
  total_tests: z.number(),
  counts: count,
});

const removedResponse = z.looseObject({ removed: z.number() });

// Writes that report what they did: bulk changes, set member adds and removals
const changedResponse = z.looseObject({ changed: z.boolean() });

// Execution create, Run now and summary
const executionRefResponse = z.looseObject({ execution_id: z.string() });

// Run claim and run removal
const runRefResponse = z.looseObject({ run_id: z.string() });

// Run detail: a run has no key of its own
const runDetailResponse = z.looseObject({
  id: z.string(),
  current_attempt: z.looseObject({ id: z.string() }),
});

// Adding tests to an execution, assigning runs, starting a new attempt
const addedResponse = z.looseObject({ added: z.number() });
const assignedResponse = z.looseObject({ assigned: z.number() });
const attemptStartedResponse = z.looseObject({ attempt_id: z.string() });

// Test cases a precondition was added to or taken off (ids, not counts)
const preconditionCasesResponse = z.looseObject({
  added: z.array(z.string()),
  removed: z.array(z.string()),
});

// Linking or creating a defect on a run
const defectLinkResponse = z.looseObject({
  id: z.string(),
  task_id: z.string(),
});
const defectCreatedResponse = z.looseObject({
  linked: z.boolean(),
  task: z.looseObject({ id: z.string() }),
});

// Runner settings: images, the files of a setting's zip, spec files and runs
const automationImagesResponse = z.looseObject({
  runner_enabled: z.boolean(),
  images: z.array(z.looseObject({ key: z.string() })),
});

const automationRunResponse = z.looseObject({
  id: z.string(),
  kind: z.string(),
  target: z.string(),
  status: z.string(),
});

const automationFilesResponse = z.looseObject({
  version: z.string().nullable(),
  files: z.array(z.looseObject({ path: z.string(), size: z.number() })),
});

const automationFileContentResponse = z.looseObject({
  path: z.string(),
  version: z.string().nullable(),
  content: z.string().nullable(),
});

const automationSpecFilesResponse = z.looseObject({
  files: z.array(z.string()),
  linked: z.array(z.string()),
});

// What an auto run of a zip would use: a framework, one that is not run, or nothing found
const automationFrameworkResponse = z.union([
  z.looseObject({
    preset: z.string(),
    image_key: z.string(),
    reason: z.string(),
  }),
  z.looseObject({ unsupported: z.string() }),
  z.looseObject({ preset: z.null() }),
]);

const automationTestCountsResponse = z.looseObject({
  total: z.number(),
  automated: z.number(),
});

const automationCiJobLogResponse = z.looseObject({
  text: z.string(),
  truncated: z.boolean(),
  bytes: z.number(),
});

// The shared test runner: its status with this space's queue, and the answer to Start
const automationRunnerResponse = z.looseObject({
  state: z.enum([
    'disabled',
    'offline',
    'starting',
    'online',
    'busy',
    'draining',
    'not_ready',
  ]),
  slots: z.number(),
  busy_slots: z.number(),
  queue: z.array(
    z.looseObject({
      run_id: z.string(),
      phase: z.enum(['running', 'next', 'waiting']),
      ahead: z.number(),
    }),
  ),
});

const automationRunnerStartResponse = z.looseObject({
  result: z.enum(['STARTED', 'STARTING', 'ALREADY_RUNNING']),
});

// Custom images: a row, whether they are on, and what Docker Hub finds
const customImageResponse = z.looseObject({
  id: z.string(),
  image_ref: z.string(),
  status: z.enum(['checking', 'approved', 'needs_admin', 'refused', 'blocked']),
  findings: z.array(z.looseObject({ code: z.string(), detail: z.string() })),
  config_ids: z.array(z.string()),
  // The stored result of the security check; status may differ while this space's approval is waiting.
  check_status: z
    .enum(['checking', 'approved', 'needs_admin', 'refused', 'blocked'])
    .optional(),
  // This space's approval, when the space asks for it.
  space_approval: z
    .looseObject({
      status: z.enum(['not_requested', 'pending', 'approved', 'rejected']),
    })
    .nullable()
    .optional(),
});

const customImageSettingsResponse = z.looseObject({
  enabled: z.boolean(),
  docker_hub_enabled: z.boolean(),
  uploads_enabled: z.boolean(),
  frameworks: z.array(z.unknown()),
});

const dockerHubRepositoryResponse = z.looseObject({
  repository: z.string(),
  official: z.boolean(),
});

const dockerHubTagsResponse = z.looseObject({
  tags: z.array(z.unknown()),
  more: z.boolean(),
});

// A space's approval of a custom image; people are an id and a name only
const approvalPerson = z.looseObject({ id: z.string(), name: z.string() });

const customImageApprovalResponse = z.looseObject({
  required: z.boolean(),
  status: z.enum([
    'not_needed',
    'not_requested',
    'pending',
    'approved',
    'rejected',
  ]),
  can_approve: z.boolean(),
  can_reject: z.boolean(),
  cannot_decide_reason: z
    .enum([
      'not_needed',
      'not_requested',
      'not_checked',
      'not_approver',
      'own_request',
      'already_voted',
    ])
    .nullable(),
  requested_by: approvalPerson.nullable(),
  requested_at: z.string().nullable(),
  decided_by: approvalPerson.nullable(),
  decided_at: z.string().nullable(),
  reason: z.string().nullable(),
  rule: z.enum(['any', 'all']),
  approver_group: z.enum(['owners', 'owners_admins']),
  no_approvers: z.boolean(),
  approvals_needed: z.number(),
  approvals_given: z.number(),
  approvers: z.array(
    approvalPerson.extend({
      decision: z.enum(['approved', 'rejected']).nullable(),
    }),
  ),
  reminder_available_at: z.string().nullable(),
  can_remind: z.boolean(),
  image: z.looseObject({ status: z.string() }).nullable(),
});

const customImageUploadResponse = z.union([
  z.looseObject({ reused: z.literal(true), image: customImageResponse }),
  z.looseObject({
    reused: z.literal(false),
    upload: z.looseObject({ url: z.string(), expires_in: z.number() }),
  }),
]);

/** Anything a Test Management route is allowed to return, as a single value. */
export const testManagementResponseSchema = z.union([
  z.looseObject({ sha256: z.string(), matched: z.array(z.unknown()) }),
  idOrName,
  listResponse,
  keyedResponse,
  namedResponse,
  settingsResponse,
  statusResponse,
  caseSavedResponse,
  planTestResponse,
  deleteResponse,
  planDeletedResponse,
  progressResponse,
  changedResponse,
  removedResponse,
  executionRefResponse,
  runRefResponse,
  runDetailResponse,
  addedResponse,
  assignedResponse,
  attemptStartedResponse,
  preconditionCasesResponse,
  defectLinkResponse,
  defectCreatedResponse,
  automationImagesResponse,
  automationRunResponse,
  automationFilesResponse,
  automationFileContentResponse,
  automationSpecFilesResponse,
  automationFrameworkResponse,
  automationTestCountsResponse,
  automationCiJobLogResponse,
  automationRunnerResponse,
  automationRunnerStartResponse,
  customImageResponse,
  customImageSettingsResponse,
  dockerHubRepositoryResponse,
  dockerHubTagsResponse,
  customImageUploadResponse,
  customImageApprovalResponse,
  z.looseObject({
    attempt_id: z.string(),
    results: z.record(z.string(), z.unknown()),
  }),
]);
