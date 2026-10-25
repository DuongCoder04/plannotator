/**
 * How the Inbox fits with your agents (the owner, for 0.28.31; copy from the
 * tour v2 brief, step 0, exactly): the top tile of the first-run "Two paths"
 * bento, and the short first card when the tour starts ("a fresh reminder").
 *
 * The picture: your own agents, three terminal sessions with their real
 * marks and nothing but their prompt (`~ claude`, `~ pi`, `~ opencode`),
 * arrows into an Inbox card, and a primary "your reply" arrow back into the Claude Code
 * session. Drawn in HTML and one inline SVG (two, the phone's runs
 * downward; CSS shows one), no asset but the tile's thumbnail. The reply
 * arrow draws once, 600 ms, not under reduced motion.
 */
import { HostMark, Icon } from '../icons';
import { tourAssetUrl } from './assets';

export const TOUR_FIT_TITLE = 'The Inbox works beside your agents';
export const TOUR_FIT_LINES = [
  'It doesn’t replace them: keep running Claude Code, Pi or OpenCode in your terminal or editor, as you do now.',
  'When they need you, they send their questions, finished work and files here.',
  'Your reply goes back into the same session, and it keeps working.',
] as const;
const PICTURE_ALT = 'Your agents keep running in your terminal and editor. They send questions, work and files to the Inbox; your reply goes back to the same session.';

/** One of your agents, as you run it now: its mark and its prompt, nothing else. */
function Session({ host, command }: { host: string; command: string }) {
  return (
    <div className="tp-win">
      <HostMark host={host} />
      <span className="tp-prompt">
        <span className="tp-tilde">~</span> {command}
      </span>
    </div>
  );
}

export function TourFitPicture() {
  return (
    <div className="tp-wrap">
      <div className="tp" role="img" aria-label={PICTURE_ALT}>
        <div className="tp-sess">
          <Session host="claude-code" command="claude" />
          <Session host="pi" command="pi" />
          <Session host="opencode" command="opencode" />
        </div>
        <svg className="tp-arrows tp-arrows-h" viewBox="0 0 70 170" aria-hidden="true">
          <path d="M2 26 C 34 26, 36 70, 66 78" />
          <path d="M2 85 L 66 85" />
          <path d="M2 144 C 34 144, 36 100, 66 92" />
          <path className="tp-ret tp-ret-draw" d="M66 108 C 38 118, 34 40, 4 34" />
          <text x="6" y="16">questions</text>
          <text className="tp-ret" x="16" y="166">
            your reply
          </text>
        </svg>
        <svg className="tp-arrows tp-arrows-v" viewBox="0 0 340 56" preserveAspectRatio="none" aria-hidden="true">
          <path d="M56 2 C 56 28, 150 30, 160 52" />
          <path d="M170 2 L 170 52" />
          <path d="M284 2 C 284 28, 190 30, 180 52" />
          <path className="tp-ret tp-ret-draw" d="M196 52 C 220 24, 80 26, 64 4" />
          <text className="tp-ret" x="196" y="30">
            your reply ↑
          </text>
        </svg>
        <div className="tp-inbox">
          <div className="tp-ih">
            <Icon name="inbox" size={13} />
            Inbox
          </div>
          <div className="tp-row">
            <HostMark host="claude-code" />
            <b>Which direction?</b>
            <span className="tp-c">1 question</span>
            {/* Not here: the row keeps its words, never a broken image. */}
            <img className="tp-th" src={tourAssetUrl('vs-a-thumb.webp')} alt="" onError={(event) => (event.currentTarget.style.display = 'none')} />
          </div>
          <div className="tp-row">
            <HostMark host="pi" />
            <b>Checkout page is done</b>
            <span className="tp-c">2 files</span>
          </div>
        </div>
      </div>
      <div className="tp-cap" aria-hidden="true">
        <span>Your agents, run as you do now</span>
        <span>The Inbox</span>
      </div>
    </div>
  );
}

/** The words: the title and its three sentences (the heading level is the host's). */
export function TourFitText({ as: Heading = 'h3', id }: { as?: 'h2' | 'h3'; id?: string }) {
  return (
    <>
      <Heading id={id} tabIndex={-1}>
        {TOUR_FIT_TITLE}
      </Heading>
      {TOUR_FIT_LINES.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </>
  );
}

/**
 * The tour's first card: the same explanation, then Show me. Not modal: the tour bar (and its Exit) stays in
 * reach above it. Focus goes to its title when it opens.
 */
export function TourIntro({ onGo }: { onGo: () => void }) {
  return (
    <div className="ib-tour-intro-scrim">
      <section className="ib-tour-intro" role="region" aria-labelledby="ib-tour-intro-h" data-tour-intro="">
        <div className="ib-ti-pic">
          <TourFitPicture />
        </div>
        <div className="ib-ti-body">
          <TourFitText as="h2" id="ib-tour-intro-h" />
          <div className="ib-ti-acts">
            <button type="button" className="ib-btn ib-pri" onClick={onGo} data-tour-intro-go="">
              Show me
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
