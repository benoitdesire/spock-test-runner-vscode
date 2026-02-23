import * as vscode from 'vscode';
import { SpockDataIteration, SpockTestClass, SpockTestMethod } from '../types';

export class TestDiscoveryService {
  private static readonly LIFECYCLE_METHODS = new Set(['setup', 'setupSpec', 'cleanup', 'cleanupSpec']);
  private static readonly CLASS_REGEX = /^(?:abstract\s+)?class\s+(\w+)\s+extends\s+(?:[\w.]*\.)?Specification\b/;
  private static readonly METHOD_HEADER_REGEX = /^(?:def|void)\s+(['"]([^'"]+)['"]|([a-zA-Z_][a-zA-Z0-9_]*))\s*(?:\([^)]*\))?\s*(\{)?\s*$/;
  private static readonly BLOCK_LABEL_REGEX = /^(given|when|then|expect|where)\s*:\s*$/;

  static parseTestsInFile(content: string): SpockTestClass[] {
    const lines = content.split('\n');
    const testClasses: SpockTestClass[] = [];
    let currentClass: SpockTestClass | null = null;
    let inClass = false;
    let classBraceBalance = 0;
    let seenClassOpeningBrace = false;
    let nestedClassBraceBalance = 0;
    let inNestedClass = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Look for class definition (only at top-level, not inside an existing class)
      if (!inClass && this.CLASS_REGEX.test(trimmedLine)) {
        const match = trimmedLine.match(this.CLASS_REGEX);
        const className = match?.[1];
        const isAbstract = trimmedLine.startsWith('abstract');
        if (className) {
          currentClass = {
            name: className,
            line: i,
            range: new vscode.Range(i, 0, i, line.length),
            methods: [],
            isAbstract: isAbstract
          };
          testClasses.push(currentClass);
          inClass = true;
          // NOTE: brace balance for this line is handled by the update section below
        }
      }
      // Detect nested class definitions (skip them; track brace depth to know when to exit)
      else if (inClass && !inNestedClass && this.CLASS_REGEX.test(trimmedLine)) {
        inNestedClass = true;
        nestedClassBraceBalance = 0; // delta for this line will be added in the update section below
      }
      // Look for test methods (only when inside a class but NOT inside a nested class)
      else if (inClass && !inNestedClass && currentClass && this.METHOD_HEADER_REGEX.test(trimmedLine)) {
        const match = trimmedLine.match(this.METHOD_HEADER_REGEX);
        const rawName = (match?.[2] || match?.[3] || '').trim();
        const hasBraceSameLine = !!match?.[4];

        if (rawName && !this.LIFECYCLE_METHODS.has(rawName)) {
          const isQuoted = !!match?.[2];
          const shouldAccept = isQuoted || this.lineHasSpockBlockLabelNearby(lines, i);
          const braceOk = hasBraceSameLine || this.hasOpeningBraceOnOrNextLine(lines, i);

          if (shouldAccept && braceOk) {
            // Check if this is a data-driven test by looking for 'where' block
            const isDataDriven = this.hasWhereBlock(lines, i);
            
            // Parse data iterations for data-driven tests
            const dataIterations = isDataDriven ? this.parseWhereBlock(lines, i, rawName) : undefined;
            
            const testMethod: SpockTestMethod = {
              name: rawName,
              line: i,
              range: new vscode.Range(i, 0, i, line.length),
              isDataDriven: isDataDriven,
              dataIterations: dataIterations && dataIterations.length > 0 ? dataIterations : undefined
            };
            currentClass.methods.push(testMethod);
          }
        }
      }

      // Update brace balances
      if (inClass) {
        const delta = this.countBraceDelta(line);
        if (delta > 0) {
          seenClassOpeningBrace = true;
        }

        if (inNestedClass) {
          nestedClassBraceBalance += delta;
          if (nestedClassBraceBalance <= 0) {
            // Exited the nested class block
            inNestedClass = false;
            nestedClassBraceBalance = 0;
          }
        }

        classBraceBalance += delta;
        if (seenClassOpeningBrace && classBraceBalance <= 0) {
          inClass = false;
          currentClass = null;
          seenClassOpeningBrace = false;
          classBraceBalance = 0;
          inNestedClass = false;
          nestedClassBraceBalance = 0;
        }
      }
    }

    return testClasses;
  }

  public static hasOpeningBraceOnOrNextLine(lines: string[], startIndex: number): boolean {
    // First check the current line itself
    if (lines[startIndex] && lines[startIndex].includes('{')) {
      return true;
    }
    // Then check the next few lines
    for (let j = startIndex + 1; j < Math.min(lines.length, startIndex + 5); j++) {
      const t = lines[j].trim();
      if (!t) {
        continue;
      }
      if (t.startsWith('//')) {
        continue;
      }
      return t.startsWith('{');
    }
    return false;
  }

  /**
   * Parse a primitive value from string (Groovy literal).
   */
  public static parseValue(value: string): any {
    const trimmed = (value || '').trim();
    if (trimmed === '' || trimmed === 'null') return null;
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    const num = Number(trimmed);
    if (!isNaN(num) && trimmed !== '') return num;
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  /**
   * Parse a pipe- or semicolon-separated data table row into an array of trimmed strings.
   */
  public static parseDataTableRow(row: string): string[] {
    const trimmed = (row || '').trim();
    if (!trimmed) return [];
    let parts: string[];
    if (trimmed.includes('|')) {
      parts = trimmed.split(/\|+/);
    } else if (trimmed.includes(';')) {
      parts = trimmed.split(/;+/);
    } else {
      return [];
    }
    return parts.map(p => p.trim()).filter(p => p !== '');
  }

  /**
   * Generate a display name for a data driven iteration.
   * Replaces #key placeholders; otherwise falls back to "methodName [k: v, ...]".
   */
  public static generateDisplayName(methodName: string, dataValues: Record<string, any>): string {
    const placeholders = methodName.match(/#[a-zA-Z_][a-zA-Z0-9_.]*/g);
    if (placeholders && placeholders.length > 0) {
      let name = methodName;
      for (const ph of placeholders) {
        const key = ph.slice(1);
        if (dataValues[key] !== undefined) {
          name = name.replace(ph, String(dataValues[key]));
        }
      }
      if (name !== methodName) return name;
    }
    const entries = Object.entries(dataValues);
    if (entries.length === 0) return methodName;
    const paramsStr = entries.map(([k, v]) => `${k}: ${v}`).join(', ');
    return `${methodName} [${paramsStr}]`;
  }

  /**
   * Parse the where: block of a test method and return iteration data.
   * Supports pipe (|, ||) and semicolon (;, ;;) separated data tables.
   */
  private static parseWhereBlock(lines: string[], methodStartIndex: number, methodName: string): SpockDataIteration[] {
    // Find the where: label within the method body
    let braceBalance = 0;
    let foundOpeningBrace = false;
    let whereBlockLine = -1;
    let methodEndLine = lines.length - 1;

    for (let j = methodStartIndex; j < lines.length; j++) {
      const line = lines[j];
      const trimmed = line.trim();
      const delta = this.countBraceDelta(line);
      if (delta > 0) foundOpeningBrace = true;
      braceBalance += delta;

      if (foundOpeningBrace && braceBalance <= 0) {
        methodEndLine = j;
        break;
      }

      if (/^where\s*:/.test(trimmed)) {
        whereBlockLine = j;
      }
    }

    if (whereBlockLine === -1) return [];

    // Scan for first table-formatted row (header)
    let headerColumns: string[] = [];
    const iterations: SpockDataIteration[] = [];
    let index = 0;

    for (let j = whereBlockLine + 1; j <= methodEndLine; j++) {
      const line = lines[j];
      if (line === undefined) break;
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
      if (trimmed === '}') break;

      // Only process table rows
      if (!trimmed.includes('|') && !trimmed.includes(';')) continue;

      const parts = this.parseDataTableRow(trimmed);
      if (parts.length === 0) continue;

      if (headerColumns.length === 0) {
        // First row is the header
        headerColumns = parts;
      } else {
        // Data row — map columns to values
        const dataValues: Record<string, any> = {};
        for (let k = 0; k < Math.min(headerColumns.length, parts.length); k++) {
          if (headerColumns[k] !== '_') {
            dataValues[headerColumns[k]] = this.parseValue(parts[k]);
          }
        }

        const displayName = this.generateDisplayName(methodName, dataValues);

        iterations.push({
          index,
          dataValues,
          displayName,
          range: new vscode.Range(j, 0, j, line.length),
          originalMethodName: methodName
        });
        index++;
      }
    }

    return iterations;
  }

  private static lineHasSpockBlockLabelNearby(lines: string[], startIndex: number): boolean {
    for (let j = startIndex + 1; j < Math.min(lines.length, startIndex + 50); j++) {
      const t = lines[j].trim();
      if (!t) {
        continue;
      }
      if (this.BLOCK_LABEL_REGEX.test(t)) {
        return true;
      }
      if (t === '}') {
        return false;
      }
    }
    return false;
  }

  private static countBraceDelta(text: string): number {
    const open = (text.match(/\{/g) || []).length;
    const close = (text.match(/\}/g) || []).length;
    return open - close;
  }

  private static hasWhereBlock(lines: string[], startIndex: number): boolean {
    let braceBalance = 0;
    let foundOpeningBrace = false;
    
    for (let j = startIndex; j < lines.length; j++) {
      const line = lines[j];
      const trimmedLine = line.trim();
      
      // Count braces to track method boundaries
      const delta = this.countBraceDelta(line);
      braceBalance += delta;
      
      if (delta > 0) {
        foundOpeningBrace = true;
      }
      
      // If we've found the opening brace and now we're back to 0, we've reached the end of the method
      if (foundOpeningBrace && braceBalance <= 0) {
        break;
      }
      
      // Look for 'where:' block
      if (this.BLOCK_LABEL_REGEX.test(trimmedLine) && trimmedLine.includes('where')) {
        return true;
      }
    }
    
    return false;
  }
}
