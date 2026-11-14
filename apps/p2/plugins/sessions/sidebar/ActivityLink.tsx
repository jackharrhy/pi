// A session name reveals its activity without adding a permanent second line to the sidebar.
import { inPage, SideNavigation } from "@p2/app/v1/web";
import { type ReactNode, useId, useRef } from "react";

/** Keeps real link navigation, with hover/focus/tap disclosure on the name and an explicit Open link. */
export function ActivityLink({
	className,
	href,
	title,
	active,
	children,
	activity,
	onActivate,
}: {
	className: string;
	href: string;
	title?: string;
	active: boolean;
	children: ReactNode;
	activity: string;
	onActivate: () => void;
}) {
	const id = useId();
	const popup = useRef<HTMLDivElement>(null);
	const show = (anchor: HTMLAnchorElement) => {
		const box = anchor.getBoundingClientRect();
		const element = popup.current;
		if (!element) return;
		element.showPopover();
		const bounds = element.getBoundingClientRect();
		const gap = Number.parseFloat(getComputedStyle(element).getPropertyValue("--s2"));
		element.style.left = `${Math.max(gap, Math.min(box.left, window.innerWidth - bounds.width - gap))}px`;
		element.style.top = `${Math.max(gap, Math.min(box.bottom, window.innerHeight - bounds.height - gap))}px`;
	};
	const close = () => popup.current?.hidePopover();
	return (
		<fieldset
			aria-label="Session name and activity"
			className="session-activity-anchor"
			onMouseLeave={(event) => {
				if (!event.currentTarget.contains(document.activeElement)) close();
			}}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) close();
			}}
		>
			<SideNavigation.Link
				className={className}
				href={href}
				title={title}
				active={active}
				aria-haspopup="dialog"
				aria-controls={id}
				onMouseEnter={(event) => show(event.currentTarget)}
				onFocus={(event) => show(event.currentTarget)}
				onClick={(event) => {
					// Name taps disclose; the rest of the stretched row link still navigates. Modified clicks remain native.
					if (
						!event.metaKey &&
						!event.ctrlKey &&
						!event.altKey &&
						!event.shiftKey &&
						event.button === 0 &&
						event.target instanceof Element &&
						event.target.closest(".session-title")
					) {
						event.preventDefault();
						show(event.currentTarget);
					} else inPage(onActivate)(event);
				}}
			>
				<span className="nav-label">{children}</span>
			</SideNavigation.Link>
			<div
				ref={popup}
				id={id}
				popover="auto"
				role="dialog"
				aria-label="Session activity"
				className="session-activity-popover"
			>
				<div className="session-activity-caption">Activity</div>
				<p>{activity}</p>
				<a
					href={href}
					onClick={inPage(() => {
						close();
						onActivate();
					})}
				>
					Open session
				</a>
				<button type="button" onClick={close} aria-label="Close activity">
					Close
				</button>
			</div>
		</fieldset>
	);
}
