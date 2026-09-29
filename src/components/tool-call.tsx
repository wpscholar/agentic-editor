/**
 * One tool call, shown inline in the assistant turn that asked for it.
 */

import * as React from 'react';
import {
	BanIcon,
	CheckIcon,
	ChevronRightIcon,
	ShieldQuestionIcon,
	TriangleAlertIcon,
	WrenchIcon,
} from 'lucide-react';
import type { DynamicToolUIPart } from 'ai';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

function format( value: unknown ): string {
	if ( value === undefined || value === null ) {
		return '{}';
	}
	if ( typeof value === 'string' ) {
		return value;
	}
	try {
		return JSON.stringify( value, null, 2 );
	} catch {
		return String( value );
	}
}

const STATE_LABELS: Record< DynamicToolUIPart[ 'state' ], string > = {
	'input-streaming': 'Preparing',
	'input-available': 'Running',
	'approval-requested': 'Waiting for approval',
	'approval-responded': 'Running',
	'output-available': 'Done',
	'output-denied': 'Denied',
	'output-error': 'Failed',
};

export function ToolCall( {
	part,
	onApprovalResponse,
}: {
	part: DynamicToolUIPart;
	/** Answers an approval request; omitted when nothing is waiting on one. */
	onApprovalResponse?: ( approvalId: string, approved: boolean ) => void;
} ) {
	const failed = part.state === 'output-error';
	const denied = part.state === 'output-denied';
	const awaitingApproval = part.state === 'approval-requested';
	const settled = part.state === 'output-available' || failed || denied;

	return (
		<div className="flex w-full flex-col gap-1.5">
			<details className="group/tool w-full rounded-lg border border-border bg-card text-xs">
				<summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
					<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90" />

					{ ! settled && ! awaitingApproval && (
						<Spinner className="size-3.5 shrink-0" />
					) }
					{ awaitingApproval && (
						<ShieldQuestionIcon className="size-3.5 shrink-0 text-muted-foreground" />
					) }
					{ denied && (
						<BanIcon className="size-3.5 shrink-0 text-muted-foreground" />
					) }
					{ part.state === 'output-available' && (
						<CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
					) }
					{ failed && (
						<TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />
					) }

					<WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />

					<span className="min-w-0 flex-1 truncate font-mono font-medium">
						{ part.toolName }
					</span>

					<span
						className={ cn(
							'shrink-0 text-muted-foreground',
							failed && 'text-destructive'
						) }
					>
						{ STATE_LABELS[ part.state ] }
					</span>
				</summary>

				<div className="flex flex-col gap-2 border-t border-border px-2.5 py-2">
					<Field label="Input" value={ format( part.input ) } />

					{ part.state === 'output-available' && (
						<Field label="Result" value={ format( part.output ) } />
					) }

					{ failed && (
						<Field
							label="Error"
							value={ part.errorText ?? 'The tool call failed.' }
							tone="destructive"
						/>
					) }
				</div>
			</details>

			{ awaitingApproval && part.approval && onApprovalResponse && (
				<ApprovalPrompt
					reason={ part.approval.requestReason }
					onRespond={ ( approved ) =>
						onApprovalResponse( part.approval!.id, approved )
					}
				/>
			) }
		</div>
	);
}

function ApprovalPrompt( {
	reason,
	onRespond,
}: {
	reason?: string;
	onRespond: ( approved: boolean ) => void;
} ) {
	return (
		<div
			role="group"
			aria-label="Approve this action"
			className="flex flex-col gap-2 rounded-lg border border-border bg-muted px-2.5 py-2 text-xs"
		>
			{ /* wp-admin's unlayered `p` margin beats a plain utility. */ }
			<p className="m-0!">
				{ reason ?? 'This action needs your approval before it runs.' }
			</p>
			<div className="flex gap-2">
				<Button size="xs" onClick={ () => onRespond( true ) }>
					Approve
				</Button>
				<Button
					size="xs"
					variant="outline"
					onClick={ () => onRespond( false ) }
				>
					Deny
				</Button>
			</div>
		</div>
	);
}

function Field( {
	label,
	value,
	tone,
}: {
	label: string;
	value: string;
	tone?: 'destructive';
} ) {
	return (
		<div className="flex flex-col gap-1">
			<span className="font-medium text-muted-foreground">{ label }</span>
			<pre
				className={ cn(
					'max-h-56 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap',
					tone === 'destructive' &&
						'bg-destructive/10 text-destructive'
				) }
			>
				{ value }
			</pre>
		</div>
	);
}
