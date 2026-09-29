/**
 * The model's thinking, collapsed above the answer it led to.
 */

import { BrainIcon, ChevronRightIcon } from 'lucide-react';

import { Markdown } from '@/components/markdown';

export function Reasoning( { text }: { text: string } ) {
	return (
		<details className="group/reasoning w-full rounded-lg border border-border text-xs text-muted-foreground">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
				<ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open/reasoning:rotate-90" />
				<BrainIcon className="size-3.5 shrink-0" />
				<span className="font-medium">Thinking</span>
			</summary>

			<div className="border-t border-border px-2.5 py-2">
				<Markdown text={ text } />
			</div>
		</details>
	);
}
