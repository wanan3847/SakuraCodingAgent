/**
 * 验证执行器。对应架构文档 §13：没有验证证据不允许 COMPLETE。
 * runCommand 可注入，测试里不需要真的跑 npm。
 */

export interface VerificationStep {
	command: string;
	exitCode: number;
	durationMs: number;
	stdoutTail: string;
	stderrTail: string;
}

export interface VerificationFailure {
	command: string;
	exitCode: number;
	reason: string;
}

export interface VerificationResult {
	passed: boolean;
	status?: "passed" | "failed" | "not_run" | "cancelled";
	steps: VerificationStep[];
	reviewedDiff: boolean;
	failures: VerificationFailure[];
}

export type CommandRunner = (command: string, cwd: string, signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface VerifyOptions {
	cwd: string;
	signal?: AbortSignal;
	commands: string[];
	run: CommandRunner;
	reviewDiff?: (cwd: string) => Promise<string[]>;
	/** 失败的 tail 保留多少字符，默认 2000 */
	tailChars?: number;
}

export async function verify(options: VerifyOptions): Promise<VerificationResult> {
	const tail = options.tailChars ?? 2000;
	const steps: VerificationStep[] = [];
	const failures: VerificationFailure[] = [];

	for (const command of options.commands) {
		options.signal?.throwIfAborted();
		const startedAt = Date.now();
		const outcome = await options.run(command, options.cwd, options.signal);
		const step: VerificationStep = {
			command,
			exitCode: outcome.exitCode,
			durationMs: Date.now() - startedAt,
			stdoutTail: tailOf(outcome.stdout, tail),
			stderrTail: tailOf(outcome.stderr, tail),
		};
		steps.push(step);
		if (outcome.exitCode !== 0) {
			failures.push({
				command,
				exitCode: outcome.exitCode,
				reason: firstMeaningfulLine(outcome.stderr) ?? firstMeaningfulLine(outcome.stdout) ?? "command failed",
			});
			break; // 先快后慢，第一个失败就停，避免刷屏和浪费
		}
	}

	const reviewFindings = options.reviewDiff ? await options.reviewDiff(options.cwd) : [];
	for (const finding of reviewFindings) {
		failures.push({ command: "diff-review", exitCode: 1, reason: finding });
	}

	return { passed: failures.length === 0 && steps.length > 0, status: failures.length ? "failed" : steps.length ? "passed" : "not_run", steps, reviewedDiff: Boolean(options.reviewDiff), failures };
}

export function tailOf(text: string, max: number): string {
	return text.length <= max ? text : text.slice(text.length - max);
}

function firstMeaningfulLine(text: string): string | undefined {
	return text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}
