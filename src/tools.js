import { z } from 'zod';

/**
 * The tool surface one DSH exposes to a peer DSH.
 *
 * Names are deliberately narrow: a peer should be able to read these three
 * names and know exactly what crosses the boundary, because everything they do
 * is a real capability on a real machine.
 */

/** Answer one question by running a whole Headless task on this machine. */
export const askTool = {
  name: 'ask',
  config: {
    title: 'Ask this machine',
    description:
      'Run one task on this machine with its own DSH (files, tools and model stay local) and return the answer. ' +
      'Use it for work that needs this machine: building, testing, reading its repositories. ' +
      'The task runs as a full agent turn, so expect minutes, not milliseconds.',
    inputSchema: {
      prompt: z.string().min(1).describe('The task, phrased as you would type it into DSH.'),
      cwd: z
        .string()
        .optional()
        .describe('Absolute working directory for the task. Must be inside the allowed directories.'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Override the task ceiling in milliseconds.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
};

/** Copy one file from this machine to the peer. */
export const fetchFileTool = {
  name: 'fetch_file',
  config: {
    title: 'Read a file from this machine',
    description:
      'Return one file from this machine as base64 with its sha256. The path must be inside the allowed directories. ' +
      'Hand the result to the peer side send_file tool to land the bytes there.',
    inputSchema: {
      path: z.string().min(1).describe('Absolute path of the file to read.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
};

/** Land one file from the peer in this machine's staging directory. */
export const sendFileTool = {
  name: 'send_file',
  config: {
    title: 'Send a file to this machine',
    description:
      'Stage one file from the peer into this machine staging directory. The declared sha256 must match the bytes. ' +
      'Files land in staging only — never at a path the peer chooses — and never overwrite an existing file.',
    inputSchema: {
      name: z.string().min(1).describe('Suggested file name. Traversal and absolute paths are reduced to a basename.'),
      content: z.string().describe('Base64 of the file bytes.'),
      sha256: z.string().describe('Lowercase hex sha256 of the decoded bytes.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
};

/** Submit a task asynchronously and get a task id back immediately. */
export const submitTaskTool = {
  name: 'submit_task',
  config: {
    title: 'Submit a task',
    description:
      'Submit one task like ask, but return a task id immediately instead of waiting for the answer. ' +
      'Poll task_status / task_events, fetch task_result once terminal, cancel with cancel_task. ' +
      'The same idempotencyKey always maps to the same task, so a retry never runs the work twice.',
    inputSchema: {
      prompt: z.string().min(1).describe('The task, phrased as you would type it into DSH.'),
      cwd: z
        .string()
        .optional()
        .describe('Absolute working directory for the task. Must be inside the allowed directories.'),
      timeoutMs: z.number().int().positive().optional().describe('Override the task ceiling in milliseconds.'),
      idempotencyKey: z
        .string()
        .min(1)
        .optional()
        .describe('Stable key of the logical operation; resubmitting it returns the existing task.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
};

/** Ask where one task stands. */
export const taskStatusTool = {
  name: 'task_status',
  config: {
    title: 'Task status',
    description:
      "Report one task's state: queued, running, completed, failed, cancelled or expired. " +
      'Survives disconnects — the state lives on the machine running the task.',
    inputSchema: {
      taskId: z.string().min(1).describe('The task id returned by submit_task.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
};

/** Read one task's lifecycle events since a cursor. */
export const taskEventsTool = {
  name: 'task_events',
  config: {
    title: 'Task events',
    description:
      "Return the task's lifecycle events (submitted, started, completed, failed, cancelled, expired) after the cursor, plus the next cursor. Incremental: pass nextCursor back on the next call.",
    inputSchema: {
      taskId: z.string().min(1).describe('The task id returned by submit_task.'),
      cursor: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Event cursor from a previous call; omit to read from the start.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
};

/** Fetch one task's terminal result. */
export const taskResultTool = {
  name: 'task_result',
  config: {
    title: 'Task result',
    description:
      "Return the finished task's answer in the same shape ask would have returned. Refuses with task-not-terminal while it still runs.",
    inputSchema: {
      taskId: z.string().min(1).describe('The task id returned by submit_task.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
};

/** Cancel one task. */
export const cancelTaskTool = {
  name: 'cancel_task',
  config: {
    title: 'Cancel a task',
    description:
      'Cancel one task: a queued task is skipped without running; a running task is killed. Cancellation is immediate and the task ends as cancelled.',
    inputSchema: {
      taskId: z.string().min(1).describe('The task id returned by submit_task.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
};

/** Every tool the Adapter serves, in registration order. */
export const TOOLS = [
  askTool,
  submitTaskTool,
  taskStatusTool,
  taskEventsTool,
  taskResultTool,
  cancelTaskTool,
  fetchFileTool,
  sendFileTool,
];
