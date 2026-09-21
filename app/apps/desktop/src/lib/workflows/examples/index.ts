// Bundled example templates and workflow notes. They are ordinary vault files
// once installed; every file name and body says "example" so they never look
// like live user data. The Workflows view installs them through the same
// package preview/apply flow as any other package, so nothing here bypasses
// collision handling.

export interface ExampleFile {
  path: string;
  kind: "template" | "workflow";
  content: string;
}

const meetingTemplate = `---
type: meeting
date: "{{date}}"
attendees: "{{attendees}}"
---
# {{topic}}

> Example meeting note created by the **Meeting note (example)** workflow on {{date}} at {{time}}.

## Attendees

{{attendees}}

## Agenda

-

## Notes

{{selection}}

## Actions

- [ ]
`;

const projectTemplate = `---
type: project
status: active
started: "{{date}}"
---
# {{name}}

> Example project note created by the **New project (example)** workflow.

## Goal

{{goal}}

## Milestones

- [ ]

## Log

- {{date}} Project created.
`;

const journalTemplate = `---
type: journal
date: "{{date}}"
---
# {{date:ddd}} {{date}}

> Example daily journal note created by the **Daily journal (example)** workflow.

## Log

## Gratitude

-
`;

function workflowNote(prose: string, definition: Record<string, unknown>): string {
  return `---
noam_kind: workflow
---
${prose}

\`\`\`json noam-workflow
${JSON.stringify(definition, null, 2)}
\`\`\`
`;
}

const meetingWorkflow = workflowNote(
  `# Meeting note (example)

Creates a dated meeting note from the example meeting template and opens it. Edit the JSON below to change the destination folder or the prompts. This is an example workflow shipped with Noam.`,
  {
    version: 1,
    id: "example-meeting-note",
    name: "Meeting note (example)",
    description: "Create a dated meeting note from the example template.",
    icon: "lucide:users",
    variables: [
      { name: "topic", label: "Topic", type: "text", required: true, placeholder: "Weekly sync" },
      { name: "attendees", label: "Attendees", type: "text", required: false, default: "" },
    ],
    requires: { templates: ["Templates/Meeting note (example).md"] },
    steps: [
      {
        type: "create-note",
        path: "Meetings/{{date}} {{topic}}.md",
        template: "Templates/Meeting note (example).md",
        onExists: "suffix",
        open: true,
      },
    ],
  },
);

const projectWorkflow = workflowNote(
  `# New project (example)

Creates a project folder with a project note from the example project template. This is an example workflow shipped with Noam.`,
  {
    version: 1,
    id: "example-new-project",
    name: "New project (example)",
    description: "Create a project note in its own folder.",
    icon: "lucide:folder-kanban",
    variables: [
      { name: "name", label: "Project name", type: "text", required: true },
      { name: "goal", label: "Goal", type: "multiline", required: false, default: "" },
    ],
    requires: { templates: ["Templates/Project (example).md"] },
    steps: [
      {
        type: "create-note",
        path: "Projects/{{name}}/{{name}}.md",
        template: "Templates/Project (example).md",
        onExists: "fail",
        open: true,
      },
    ],
  },
);

const journalWorkflow = workflowNote(
  `# Daily journal (example)

Opens today's journal note, creating it from the example journal template when it does not exist yet. This is an example workflow shipped with Noam.`,
  {
    version: 1,
    id: "example-daily-journal",
    name: "Daily journal (example)",
    description: "Open or create today's journal note.",
    icon: "lucide:book-open",
    shortcut: "mod+shift+j",
    requires: { templates: ["Templates/Daily journal (example).md"] },
    steps: [
      {
        type: "create-note",
        path: "Journal/{{date}}.md",
        template: "Templates/Daily journal (example).md",
        onExists: "open",
        open: true,
      },
    ],
  },
);

const journalEntryWorkflow = workflowNote(
  `# Journal entry (example)

Appends a timestamped line under the **Log** heading of today's journal note, creating the note from the example template when needed. Useful from the slash menu or a shortcut while working in another note. This is an example workflow shipped with Noam.`,
  {
    version: 1,
    id: "example-journal-entry",
    name: "Journal entry (example)",
    description: "Append a timestamped entry to today's journal.",
    icon: "lucide:pen-line",
    variables: [{ name: "entry", label: "Entry", type: "multiline", required: true }],
    requires: { templates: ["Templates/Daily journal (example).md"] },
    steps: [
      {
        type: "append",
        target: { path: "Journal/{{date}}.md" },
        heading: "## Log",
        position: "end",
        content: "- {{time}} {{entry}}",
        createIfMissing: { template: "Templates/Daily journal (example).md" },
      },
    ],
  },
);

const taskCaptureWorkflow = workflowNote(
  `# Capture task (example)

Adds a task to the **Inbox** heading of \`Tasks/Inbox.md\` without leaving the note you are working in. The inbox note is created on first use. This is an example workflow shipped with Noam.`,
  {
    version: 1,
    id: "example-capture-task",
    name: "Capture task (example)",
    description: "Add a task to the shared inbox note.",
    icon: "lucide:inbox",
    shortcut: "mod+shift+t",
    variables: [{ name: "task", label: "Task", type: "text", required: true, placeholder: "Call the dentist" }],
    steps: [
      {
        type: "append",
        target: { path: "Tasks/Inbox.md" },
        heading: "## Inbox",
        position: "end",
        content: "- [ ] {{task}} ({{date}})",
        createIfMissing: {
          content: "# Task inbox (example)\n\n> Example inbox created by the **Capture task (example)** workflow.\n\n## Inbox\n\n## Done\n",
        },
      },
    ],
  },
);

const clipboardCaptureWorkflow = workflowNote(
  `# Paste clipboard as quote (example)

Inserts the clipboard text as a quote at the caret of the current note. The clipboard is only read when you press **Paste** in the prompt; nothing is read automatically. This is an example workflow shipped with Noam.`,
  {
    version: 1,
    id: "example-clipboard-quote",
    name: "Paste clipboard as quote (example)",
    description: "Insert the clipboard as a block quote in the current note.",
    icon: "lucide:clipboard-paste",
    variables: [{ name: "clip", label: "Clipboard", type: "clipboard", required: true }],
    steps: [{ type: "insert", target: "current", content: "> {{clip}}\n> — captured {{date}} {{time}}" }],
  },
);

export const EXAMPLE_FILES: readonly ExampleFile[] = [
  { path: "Templates/Meeting note (example).md", kind: "template", content: meetingTemplate },
  { path: "Templates/Project (example).md", kind: "template", content: projectTemplate },
  { path: "Templates/Daily journal (example).md", kind: "template", content: journalTemplate },
  { path: "Workflows/Meeting note (example).md", kind: "workflow", content: meetingWorkflow },
  { path: "Workflows/New project (example).md", kind: "workflow", content: projectWorkflow },
  { path: "Workflows/Daily journal (example).md", kind: "workflow", content: journalWorkflow },
  { path: "Workflows/Journal entry (example).md", kind: "workflow", content: journalEntryWorkflow },
  { path: "Workflows/Capture task (example).md", kind: "workflow", content: taskCaptureWorkflow },
  { path: "Workflows/Paste clipboard as quote (example).md", kind: "workflow", content: clipboardCaptureWorkflow },
];

export const EXAMPLES_PACKAGE_ID = "noam-examples";
export const EXAMPLES_PACKAGE_VERSION = "1.0.0";
