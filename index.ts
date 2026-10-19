// Notify: a desktop notification and a sound when the agent needs you. By default it fires when a
// run finishes, when a run fails, when a permission prompt is waiting, and when the agent asks a
// question. A prompt that stays unanswered is re-sent every two minutes, up to three times, and
// the reminders stop the moment anything moves (an answer, a new turn, the run ending).
//
// Native notifications go through the platform's own tool: osascript on macOS, notify-send on
// Linux, a PowerShell toast on Windows. A missing tool is skipped silently. Sounds are the two
// WAV files shipped next to this file (a chime when work is done, an alert when you are needed);
// where no player exists, the terminal bell rings instead.
//
// The model can send one itself with the notify_user tool (a long build finished, a decision is
// needed). /notify shows and changes the settings, which are kept across sessions:
//   /notify                          status
//   /notify test                     send a test notification
//   /notify <event> on|off           complete | failed | permission | question | session_end
//   /notify sound|native|recap on|off
//   /notify command <cmd>|default    run your own notifier with the title and message as arguments
// `recap` (off by default) turns the "finished" message into a one-line summary of the reply,
// written by the session model: one short extra model call per run.

import type {AgentRunResult, ModApi} from '@commandcode/harness';

export type NotifyEvent =
	| 'complete'
	| 'failed'
	| 'permission'
	| 'question'
	| 'session_end';

export interface NotifySettings {
	readonly events: Readonly<Record<NotifyEvent, boolean>>;
	readonly sound: boolean;
	readonly native: boolean;
	readonly recap: boolean;
	// Replaces the platform notifier: run with [title, message] as its arguments.
	readonly command?: string;
	readonly renotify: {
		readonly enabled: boolean;
		readonly intervalMs: number;
		readonly maxRepeats: number;
	};
}

export const DEFAULT_SETTINGS: NotifySettings = {
	events: {
		complete: true,
		failed: true,
		permission: true,
		question: true,
		session_end: false,
	},
	sound: true,
	native: true,
	recap: false,
	renotify: {enabled: true, intervalMs: 120_000, maxRepeats: 3},
};

const EVENTS: readonly NotifyEvent[] = [
	'complete',
	'failed',
	'permission',
	'question',
	'session_end',
];
const SETTINGS_KEY = 'settings';
const QUESTION_TOOL = 'ask_user_question';
const APP_TITLE = 'Command Code';
const DONE_SOUND = './sounds/done.wav';
const ALERT_SOUND = './sounds/alert.wav';
const RECAP_INPUT_CHARS = 4000;
const MESSAGE_LIMIT = 200;

type Priority = 'low' | 'normal' | 'high';

function isEvent(value: string): value is NotifyEvent {
	return (EVENTS as readonly string[]).includes(value);
}

/** Stored settings merged over the defaults, so new fields always exist. */
export function mergeSettings(stored: unknown): NotifySettings {
	if (!stored || typeof stored !== 'object') return DEFAULT_SETTINGS;
	const raw = stored as Partial<NotifySettings>;
	const events = Object.fromEntries(
		EVENTS.map(event => [
			event,
			typeof raw.events?.[event] === 'boolean'
				? raw.events[event]
				: DEFAULT_SETTINGS.events[event],
		]),
	) as Record<NotifyEvent, boolean>;
	const renotify = raw.renotify;
	return {
		events,
		sound:
			typeof raw.sound === 'boolean' ? raw.sound : DEFAULT_SETTINGS.sound,
		native:
			typeof raw.native === 'boolean'
				? raw.native
				: DEFAULT_SETTINGS.native,
		recap:
			typeof raw.recap === 'boolean' ? raw.recap : DEFAULT_SETTINGS.recap,
		...(typeof raw.command === 'string' && raw.command.trim()
			? {command: raw.command.trim()}
			: {}),
		renotify: {
			enabled:
				typeof renotify?.enabled === 'boolean'
					? renotify.enabled
					: DEFAULT_SETTINGS.renotify.enabled,
			intervalMs:
				typeof renotify?.intervalMs === 'number' &&
				renotify.intervalMs >= 1000
					? renotify.intervalMs
					: DEFAULT_SETTINGS.renotify.intervalMs,
			maxRepeats:
				typeof renotify?.maxRepeats === 'number' &&
				renotify.maxRepeats >= 0
					? Math.floor(renotify.maxRepeats)
					: DEFAULT_SETTINGS.renotify.maxRepeats,
		},
	};
}

function clip(text: string, limit = MESSAGE_LIMIT): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

// AppleScript string literal: backslashes and double quotes escaped.
function appleScriptString(text: string): string {
	return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// PowerShell single-quoted literal: a quote is written twice.
function powerShellString(text: string): string {
	return `'${text.replace(/'/g, "''")}'`;
}

/** The command that shows a native notification on this platform, or undefined when none. */
export function nativeCommand(params: {
	readonly platform: NodeJS.Platform;
	readonly title: string;
	readonly message: string;
	readonly override?: string;
}): {readonly command: string; readonly args: readonly string[]} | undefined {
	const {title, message} = params;
	if (params.override)
		return {command: params.override, args: [title, message]};
	if (params.platform === 'darwin')
		return {
			command: 'osascript',
			args: [
				'-e',
				`display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`,
			],
		};
	if (params.platform === 'win32') {
		const script = [
			'[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
			'$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
			'$text = $xml.GetElementsByTagName("text")',
			`$text.Item(0).AppendChild($xml.CreateTextNode(${powerShellString(title)})) > $null`,
			`$text.Item(1).AppendChild($xml.CreateTextNode(${powerShellString(message)})) > $null`,
			'$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
			'[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Command Code").Show($toast)',
		].join('; ');
		return {
			command: 'powershell',
			args: ['-NoProfile', '-NonInteractive', '-Command', script],
		};
	}
	if (params.platform === 'linux')
		return {command: 'notify-send', args: [title, message]};
	return undefined;
}

/** What a finished run says, or undefined when it should stay quiet (the person interrupted it). */
export function runEndNotice(params: {
	readonly result: AgentRunResult;
	readonly sessionName: string | undefined;
	// The run_error that ended the run, which arrives just before run_end.
	readonly errorMessage?: string;
}): {readonly event: NotifyEvent; readonly message: string} | undefined {
	const {result, sessionName, errorMessage} = params;
	const prefix = sessionName ? `${sessionName}: ` : '';
	if (result.stopReason === 'interrupted') return undefined;
	if (result.stopReason === 'run_error')
		return {
			event: 'failed',
			message: `${prefix}the run failed${errorMessage ? `: ${clip(errorMessage, 120)}` : ''}`,
		};
	if (result.stopReason === 'max_turns')
		return {
			event: 'complete',
			message: `${prefix}stopped at the turn limit after ${result.turnCount} turns`,
		};
	if (result.stopReason === 'permission_denied')
		return {
			event: 'complete',
			message: `${prefix}stopped: a permission was declined`,
		};
	return {event: 'complete', message: `${prefix}the agent is done`};
}

function eventLabel(event: NotifyEvent): string {
	if (event === 'complete') return 'Done';
	if (event === 'failed') return 'Run failed';
	if (event === 'permission') return 'Permission needed';
	if (event === 'question') return 'Question for you';
	return 'Session ended';
}

function isBlocking(event: NotifyEvent): boolean {
	return event === 'permission' || event === 'question';
}

function statusText(settings: NotifySettings): string {
	const on = EVENTS.filter(event => settings.events[event]);
	return [
		`Events: ${on.length ? on.join(', ') : 'none'}`,
		`Native: ${settings.native ? 'on' : 'off'}${settings.command ? ` (command: ${settings.command})` : ''}`,
		`Sound: ${settings.sound ? 'on' : 'off'}`,
		`Recap: ${settings.recap ? 'on' : 'off'}`,
		`Reminders for unanswered prompts: ${settings.renotify.enabled ? `every ${Math.round(settings.renotify.intervalMs / 1000)}s, up to ${settings.renotify.maxRepeats} times` : 'off'}`,
	].join('\n');
}

export default function notify(cmd: ModApi): void {
	let settings = mergeSettings(cmd.store.get(SETTINGS_KEY));
	let reminder: {dispose(): void} | undefined;
	let blockingToolCallId: string | undefined;
	let runErrorMessage: string | undefined;

	const save = (next: NotifySettings): void => {
		settings = next;
		cmd.store.set(SETTINGS_KEY, next).catch(() => {
			cmd.ui.notify('notify: could not save the settings.', 'warning');
		});
	};

	const disarmReminder = (): void => {
		reminder?.dispose();
		reminder = undefined;
		blockingToolCallId = undefined;
	};

	const showNative = async (
		title: string,
		message: string,
	): Promise<void> => {
		const target = nativeCommand({
			platform: process.platform,
			title,
			message,
			...(settings.command ? {override: settings.command} : {}),
		});
		if (!target) return;
		try {
			await cmd.process.spawn({
				command: target.command,
				args: [...target.args],
				signal: AbortSignal.timeout(10_000),
				onOutput: () => {},
			});
		} catch {
			// A notifier that hangs or cannot start is not worth an error: the sound still plays.
		}
	};

	const playSound = async (priority: Priority): Promise<void> => {
		const played = await cmd.audio.play({
			file: priority === 'high' ? ALERT_SOUND : DONE_SOUND,
		});
		// No player for the file (or no file): the terminal bell still gets attention.
		if (
			!played.isPlayed &&
			(played.reason === 'no-player' || played.reason === 'not-found')
		)
			cmd.audio.bell();
	};

	// Every notification goes through here; it never throws and never blocks the caller.
	const send = (params: {
		readonly event?: NotifyEvent;
		readonly title: string;
		readonly message: string;
		readonly priority: Priority;
	}): Promise<void> => {
		const jobs = [
			...(settings.native
				? [showNative(params.title, clip(params.message))]
				: []),
			...(settings.sound ? [playSound(params.priority)] : []),
		];
		return Promise.allSettled(jobs).then(() => undefined);
	};

	const titleFor = (event: NotifyEvent): string => {
		const name = cmd.getSessionName();
		return `${APP_TITLE}: ${eventLabel(event)}${name ? ` (${name})` : ''}`;
	};

	const fire = (event: NotifyEvent, message: string): void => {
		if (!settings.events[event]) return;
		const priority: Priority = isBlocking(event)
			? 'high'
			: event === 'failed'
				? 'normal'
				: 'low';
		void send({event, title: titleFor(event), message, priority});
		if (!isBlocking(event) || !settings.renotify.enabled) return;
		if (settings.renotify.maxRepeats <= 0) return;
		// One prompt can be outstanding at a time: a new one replaces the old reminder.
		reminder?.dispose();
		let fired = 0;
		reminder = cmd.clock.every(settings.renotify.intervalMs, () => {
			fired += 1;
			void send({
				event,
				title: `${titleFor(event)} (still waiting)`,
				message,
				priority: 'high',
			});
			if (fired >= settings.renotify.maxRepeats) disarmReminder();
		});
	};

	const recap = async (finalText: string): Promise<string | undefined> => {
		if (!settings.recap || !finalText.trim()) return undefined;
		const answer = await cmd.model.complete({
			prompt: `Summarize what this reply reports, in one short sentence under 100 characters. Plain text, no quotes.\n\n${finalText.slice(-RECAP_INPUT_CHARS)}`,
			maxOutputTokens: 60,
		});
		return answer.isAnswered && answer.text.trim()
			? clip(answer.text, 120)
			: undefined;
	};

	cmd.on('run_start', () => {
		runErrorMessage = undefined;
	});

	// A failing run emits run_error and then run_end: remember the error, notify once at the end.
	cmd.on('run_error', event => {
		if (event.type !== 'run_error') return;
		runErrorMessage = event.error.message;
	});

	cmd.on('run_end', event => {
		if (event.type !== 'run_end') return;
		disarmReminder();
		const notice = runEndNotice({
			result: event.result,
			sessionName: cmd.getSessionName(),
			...(runErrorMessage === undefined
				? {}
				: {errorMessage: runErrorMessage}),
		});
		runErrorMessage = undefined;
		if (!notice || !settings.events[notice.event]) return;
		if (notice.event !== 'complete' || !settings.recap) {
			fire(notice.event, notice.message);
			return;
		}
		void recap(event.result.finalText)
			.catch(() => undefined)
			.then(summary => {
				fire(notice.event, summary ?? notice.message);
			});
	});

	// The question tool waits on the person until it completes.
	cmd.on('tool_running', event => {
		if (event.type !== 'tool_running') return;
		if (event.toolName !== QUESTION_TOOL) {
			disarmReminder();
			return;
		}
		fire(
			'question',
			event.description ?? 'the agent is waiting for your answer',
		);
		blockingToolCallId = event.toolCallId;
	});
	for (const done of ['tool_completed', 'tool_errored'] as const)
		cmd.on(done, event => {
			if (
				event.type !== 'tool_completed' &&
				event.type !== 'tool_errored'
			)
				return;
			if (event.toolCallId === blockingToolCallId) disarmReminder();
		});
	for (const moved of ['turn_start', 'tool_denied', 'interrupted'] as const)
		cmd.on(moved, () => {
			disarmReminder();
		});

	cmd.on('session_shutdown', () => {
		disarmReminder();
		fire('session_end', 'the session ended');
	});

	cmd.hooks({
		// Fires only where the person is about to be asked: notify, then leave the answer to them.
		onPermissionRequest: ({toolName, description}) => {
			fire(
				'permission',
				`${toolName}${description ? `: ${description}` : ''} is waiting for your approval`,
			);
			return undefined;
		},
	});

	cmd.addTool({
		schema: {
			name: 'notify_user',
			description:
				'Send the user a desktop notification (with a sound). Use it sparingly: when long work they are waiting on finishes, or when you need a decision and they may be away. Not for routine progress.',
			input_schema: {
				type: 'object',
				properties: {
					title: {type: 'string', description: 'Short title'},
					message: {
						type: 'string',
						description: 'One or two sentences',
					},
					priority: {
						type: 'string',
						enum: ['low', 'normal', 'high'],
						description:
							'high plays the alert sound; default normal',
					},
				},
				required: ['message'],
			},
		},
		readOnly: true,
		run: async ({input}) => {
			const message =
				typeof input.message === 'string' ? input.message : '';
			if (!message.trim())
				return {ok: false, error: 'notify_user: message is required'};
			const priority: Priority =
				input.priority === 'low' || input.priority === 'high'
					? input.priority
					: 'normal';
			const title =
				typeof input.title === 'string' && input.title.trim()
					? `${APP_TITLE}: ${clip(input.title, 60)}`
					: APP_TITLE;
			await send({title, message, priority});
			return {
				ok: true,
				content: [{type: 'text', text: 'Notification sent.'}],
			};
		},
	});

	cmd.addCommand({
		name: 'notify',
		description:
			'Show or change when you get desktop notifications and sounds',
		argumentHint:
			'[test | <event> on|off | sound|native|recap on|off | command <cmd>|default]',
		handler: async ({args}) => {
			const [head = '', value = '', ...rest] = args.trim().split(/\s+/);
			if (!head) return {message: statusText(settings)};
			if (head === 'test') {
				await send({
					title: `${APP_TITLE}: Test`,
					message: 'Notifications are working.',
					priority: 'high',
				});
				return {message: 'Test notification sent.'};
			}
			if (head === 'command') {
				const command = [value, ...rest].join(' ').trim();
				if (!command || command === 'default') {
					const {command: _dropped, ...withoutCommand} = settings;
					save(withoutCommand);
					return {message: 'Using the platform notifier.'};
				}
				save({...settings, command});
				return {
					message: `Notifications run: ${command} <title> <message>`,
				};
			}
			if (value !== 'on' && value !== 'off')
				return {message: `Usage: /notify ${head} on|off`};
			const isOn = value === 'on';
			if (head === 'sound' || head === 'native' || head === 'recap') {
				save({...settings, [head]: isOn});
				return {message: `${head}: ${value}`};
			}
			if (!isEvent(head))
				return {
					message: `Unknown setting "${head}". Events: ${EVENTS.join(', ')}; or sound, native, recap.`,
				};
			save({...settings, events: {...settings.events, [head]: isOn}});
			return {message: `${head} notifications: ${value}`};
		},
	});
}
