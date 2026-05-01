/**
 * SimpleClaw — NotebookEdit Tool
 * Edit Jupyter notebook (.ipynb) cells with replace / insert / delete operations.
 * Cell indices are 0-based.
 */

import type { ISandbox, ITool } from "../../core/interfaces.js";

type CellType = "code" | "markdown";
type EditMode = "replace" | "insert" | "delete";

interface NotebookCell {
  cell_type: CellType;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

function normalizeSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

function toSourceArray(source: string): string[] {
  if (!source.includes("\n")) return [source];
  const lines = source.split("\n");
  // Jupyter convention: every line except the last ends with \n
  return lines.map((l, i) => (i < lines.length - 1 ? l + "\n" : l));
}

export function createNotebookEditTool(sandbox: ISandbox): ITool {
  return {
    name: "notebook_edit",
    description:
      "Edit a Jupyter notebook (.ipynb) file. Supports replace, insert, and delete " +
      "operations on cells. Cell indices are 0-based. " +
      "For 'replace' and 'insert', provide the new cell content. " +
      "For 'delete', only the cell_index is needed. " +
      "The notebook is validated before writing.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the .ipynb file" },
        edit_mode: {
          type: "string",
          enum: ["replace", "insert", "delete"],
          description: "Operation to perform",
        },
        cell_index: {
          type: "number",
          description: "0-based index of the target cell (for replace/delete) or insertion point (for insert). For insert, the new cell is placed BEFORE the existing cell at this index. Use -1 or the length of cells to append at the end.",
        },
        cell_type: {
          type: "string",
          enum: ["code", "markdown"],
          description: "Type of the new/replaced cell (required for replace and insert)",
        },
        source: {
          type: "string",
          description: "Cell source content (required for replace and insert)",
        },
      },
      required: ["path", "edit_mode", "cell_index"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const path = String(args.path);
      const editMode = String(args.edit_mode) as EditMode;
      const cellIndex = Number(args.cell_index);

      if (!path.endsWith(".ipynb")) {
        return `Error: "${path}" does not look like a notebook file (expected .ipynb extension)`;
      }

      // Read and parse notebook
      let raw: string;
      try {
        raw = await sandbox.readFile(path);
      } catch (e) {
        return `Error reading notebook: ${e instanceof Error ? e.message : String(e)}`;
      }

      let notebook: Notebook;
      try {
        notebook = JSON.parse(raw) as Notebook;
      } catch {
        return `Error: ${path} is not valid JSON`;
      }

      if (!Array.isArray(notebook.cells)) {
        return `Error: notebook has no "cells" array`;
      }

      const cells = notebook.cells;

      // Validate cell_index bounds for replace/delete
      if (editMode !== "insert") {
        if (cellIndex < 0 || cellIndex >= cells.length) {
          return `Error: cell_index ${cellIndex} is out of bounds (notebook has ${cells.length} cells, valid indices: 0-${cells.length - 1})`;
        }
      }

      switch (editMode) {
        case "replace": {
          const cellType = String(args.cell_type) as CellType;
          const source = args.source !== undefined ? String(args.source) : undefined;

          if (!cellType || !["code", "markdown"].includes(cellType)) {
            return `Error: cell_type must be "code" or "markdown" for replace`;
          }
          if (source === undefined) {
            return `Error: source is required for replace`;
          }

          const oldCell = cells[cellIndex];
          const oldPreview = normalizeSource(oldCell.source).slice(0, 80).replace(/\n/g, "\\n");
          const newCell: NotebookCell = {
            cell_type: cellType,
            source: toSourceArray(source),
            metadata: oldCell.metadata ?? {},
          };
          if (cellType === "code") {
            newCell.outputs = [];
            newCell.execution_count = null;
          }
          cells[cellIndex] = newCell;

          try {
            await sandbox.writeFile(path, JSON.stringify(notebook, null, 1) + "\n");
          } catch (e) {
            return `Error writing notebook: ${e instanceof Error ? e.message : String(e)}`;
          }

          return `Replaced cell ${cellIndex} (${oldCell.cell_type} -> ${cellType}). Old content preview: "${oldPreview}"`;
        }

        case "insert": {
          const cellType = String(args.cell_type) as CellType;
          const source = args.source !== undefined ? String(args.source) : undefined;

          if (!cellType || !["code", "markdown"].includes(cellType)) {
            return `Error: cell_type must be "code" or "markdown" for insert`;
          }
          if (source === undefined) {
            return `Error: source is required for insert`;
          }

          const clampedIndex = Math.max(0, Math.min(cellIndex, cells.length));
          const newCell: NotebookCell = {
            cell_type: cellType,
            source: toSourceArray(source),
            metadata: {},
          };
          if (cellType === "code") {
            newCell.outputs = [];
            newCell.execution_count = null;
          }
          cells.splice(clampedIndex, 0, newCell);

          try {
            await sandbox.writeFile(path, JSON.stringify(notebook, null, 1) + "\n");
          } catch (e) {
            return `Error writing notebook: ${e instanceof Error ? e.message : String(e)}`;
          }

          return `Inserted new ${cellType} cell at index ${clampedIndex}. Notebook now has ${cells.length} cells.`;
        }

        case "delete": {
          const deleted = cells.splice(cellIndex, 1)[0];
          const preview = normalizeSource(deleted.source).slice(0, 80).replace(/\n/g, "\\n");

          try {
            await sandbox.writeFile(path, JSON.stringify(notebook, null, 1) + "\n");
          } catch (e) {
            return `Error writing notebook: ${e instanceof Error ? e.message : String(e)}`;
          }

          return `Deleted cell ${cellIndex} (${deleted.cell_type}). Content preview: "${preview}". Notebook now has ${cells.length} cells.`;
        }

        default:
          return `Error: unknown edit_mode "${editMode}"`;
      }
    },
  };
}
