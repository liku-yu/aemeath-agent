import type { Tool } from "../../types.js";
import { readFileTool, writeFileTool, listDirTool } from "./file.js";
import { editFileTool } from "./edit.js";
import { runCommandTool } from "./exec.js";
import { grepTool, globTool } from "./search.js";
import { noteSaveTool, noteSearchTool } from "./notes.js";
import { todoTool } from "./todo.js";
import { subagentTool } from "./subagent.js";
import { webFetchTool } from "./web.js";
import { enterPlanModeTool, exitPlanModeTool } from "./plan.js";

/** The default built-in toolset. */
export function builtinTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    globTool,
    grepTool,
    runCommandTool,
    webFetchTool,
    noteSaveTool,
    noteSearchTool,
    todoTool,
    subagentTool,
    enterPlanModeTool,
    exitPlanModeTool,
  ];
}

export { readFileTool, writeFileTool, editFileTool, listDirTool, grepTool, globTool, runCommandTool, todoTool, webFetchTool };
