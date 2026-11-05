import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// Some navigation widgets reassign all their labels on every interaction, even unchanged ones.
function Label({ text, revision }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    ref.current.firstChild.data = text;
  }, [text, revision]);
  return <span ref={ref}>{text}</span>;
}

function Tabs() {
  const [active, setActive] = useState(0);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState('');
  const [placeholder, setPlaceholder] = useState('Title');
  const [menu, setMenu] = useState(false);
  return (
    <>
      <main aria-hidden={menu || undefined}>
        <nav role="tablist">
          {['Overview', 'Free Tier Categories', 'Terms and Conditions'].map((text, index) => (
            <button
              key={text}
              role="tab"
              aria-selected={active === index}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') {
                  setActive((index + 1) % 3);
                  setRevision((value) => value + 1);
                }
              }}
              onClick={() => {
                setActive(index);
                setRevision((value) => value + 1);
              }}
            >
              <Label text={text} revision={revision} />
            </button>
          ))}
        </nav>
        <h1>
          <Label text="AWS Free Tier" revision={revision} />
        </h1>
        <p>
          <Label text="Get started for free" revision={revision} />
        </p>
        <input
          id="view-title"
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <textarea id="view-description" placeholder="Add a description" />
        <button id="rename" title="Rename view" onClick={() => setPlaceholder('New title')}>
          重命名
        </button>
        <input id="password" type="password" placeholder="Private password hint" />
        <input id="opted-out" placeholder="Keep this hint" translate="no" />
        <input hidden placeholder="Hidden hint" />
        <output id="draft-value" translate="no">
          {draft}
        </output>
        <button id="open-menu" onClick={() => setMenu(true)}>
          更多
        </button>
      </main>
      {menu && (
        <div role="dialog">
          <p>Show details</p>
          <button id="close-menu" onClick={() => setMenu(false)}>
            关闭
          </button>
        </div>
      )}
    </>
  );
}

createRoot(document.querySelector('#root')).render(<Tabs />);
