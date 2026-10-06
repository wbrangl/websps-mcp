export interface RulesOperator {
  token: string;
  params: string[];
}

export interface LintIssue {
  line: number;
  message: string;
}

/**
 * Server-side checks before rules reach the device, complementing the device's `validate`:
 * the device compiler tokenizes with strtok(), so an empty parameter in the middle (`;;`) is
 * silently skipped and all following fields shift left. The device only warns about that.
 */
export function lintRules(
  content: string,
  operators: readonly RulesOperator[],
): { errors: LintIssue[]; warnings: LintIssue[] } {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const withParams = operators.filter((op) => op.params.length > 0 && /^[A-Z]+$/.test(op.token));
  let inBlockComment = false;

  content.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1;
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    line = line.replace(/\/\*.*?\*\//g, " ");
    const blockStart = line.indexOf("/*");
    if (blockStart >= 0) {
      inBlockComment = true;
      line = line.slice(0, blockStart);
    }
    // Quoted texts may contain ';' or '//'; neutralize them before looking at the structure.
    line = line.replace(/"[^"]*"/g, '"Q"');
    const comment = line.indexOf("//");
    if (comment >= 0) line = line.slice(0, comment);
    if (line.trim() === "") return;

    const tokens = withParams.length > 0 ? withParams.map((op) => op.token) : ["[A-Z]{3}"];
    const match = new RegExp(`\\s(${tokens.join("|")})\\s+(.*)$`).exec(line);
    if (match === null) {
      if (/;\s*;/.test(line)) errors.push({ line: lineNo, message: "empty parameter (';;')" });
      return;
    }
    const token = match[1] as string;
    const params = (match[2] as string).trim();
    if (!params.includes(";")) return;

    const fields = params.split(";");
    // A complete parameter list ends with ';', leaving one empty element at the end.
    if (fields.at(-1)?.trim() === "") fields.pop();
    fields.forEach((field, i) => {
      if (field.trim() === "") {
        errors.push({
          line: lineNo,
          message: `${token}: parameter ${i + 1} is empty; the device would shift the following fields`,
        });
      }
    });
    const operator = withParams.find((op) => op.token === token);
    if (operator !== undefined && fields.length < operator.params.length) {
      warnings.push({
        line: lineNo,
        message: `${token}: ${fields.length} parameters, operator expects ${operator.params.length} (${operator.params.join(";")})`,
      });
    }
  });
  return { errors, warnings };
}
