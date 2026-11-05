import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

// A real React tree: labels, fragments, conditional children, keyed rows and native form values.
function Console() {
  const [status, setStatus] = useState('Running');
  const [details, setDetails] = useState(true);
  const [rows, setRows] = useState(['i-0123456789abcdef0']);
  const [selected, setSelected] = useState(false);
  return (
    <main>
      <nav>
        <a id="documentation" href="#documentation">
          Documentation
        </a>
      </nav>
      <h1>Instances</h1>
      <div className="actions">
        <button
          id="refresh"
          onClick={() => setStatus((value) => (value === 'Running' ? 'Stopped' : 'Running'))}
        >
          Refresh
        </button>
        <button id="details-toggle" onClick={() => setDetails(!details)}>
          Show details
        </button>
        <button id="add-row" onClick={() => setRows([...rows, 'i-abcdef01234567890'])}>
          Add instance
        </button>
      </div>
      <label>
        Filter instances <input id="filter" defaultValue="production" />
      </label>
      <label>
        Environment{' '}
        <select id="environment">
          <option>Production</option>
          <option>Development</option>
        </select>
      </label>
      <label>
        <input
          id="selected"
          type="checkbox"
          checked={selected}
          onChange={(event) => setSelected(event.target.checked)}
        />
        Select instance
      </label>
      <table>
        <thead>
          <tr>
            <th>Instance ID</th>
            <th>State</th>
            <th>Region</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((id) => (
            <tr key={id}>
              <td>{id}</td>
              <td className="state">{status}</td>
              <td>us-east-1</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p id="conditional">
        {details && 'Instance details'}
        <a href="#documentation">Read documentation</a>
      </p>
      {details && (
        <section id="details">
          <h2>Instance details</h2>
          <code>arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0</code>
        </section>
      )}
      <p id="selection">Before selected words after</p>
      <p id="stream">A deliberately streamed webpage paragraph.</p>
      <p id="pending">A slow original pending text.</p>
      <div contentEditable suppressContentEditableWarning>
        Private draft
      </div>
    </main>
  );
}

createRoot(document.querySelector('#root')).render(<Console />);
setTimeout(() => {
  const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_ALL);
  const nodes = [];
  while (walker.nextNode())
    nodes.push({ node: walker.currentNode, parent: walker.currentNode.parentNode });
  window.consoleFixture = {
    identityPreserved: () =>
      nodes.every(({ node, parent }) => node.isConnected && node.parentNode === parent),
    allText: () =>
      nodes.filter(({ node }) => node.nodeType === Node.TEXT_NODE).map(({ node }) => node.data),
  };
  document.body.dataset.ready = 'true';
}, 50);
