import { useState, useCallback, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import './App.css';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

//const API = 'http://localhost:8787'; // 本地开发
const API = 'https://examops-backend.moral-study-dh.workers.dev';

const INITIAL = {
  topic: '', objective: '', numDistractors: 4,
};

const CLASS_DESCRIPTIONS = {
  'EECS 485': 'Web Systems — covers web infrastructure, search engines, social networks, and large-scale data processing.',
  'EECS 370': 'Introduction to Computer Organization — covers assembly, memory hierarchy, pipelines, and computer architecture.',
};

function App() {
  const [view, setView] = useState('dashboard');

  // Classes
  const [classes, setClasses] = useState([]);
  const [selectedClass, setSelectedClass] = useState(null); // { id, name }

  // Form inputs
  const [topic, setTopic] = useState(INITIAL.topic);
  const [objective, setObjective] = useState(INITIAL.objective);
  const format = 'MCQ';
  const [numDistractors, setNumDistractors] = useState(INITIAL.numDistractors);

  // Generated question
  const [question, setQuestion] = useState(null);
  const [questionId, setQuestionId] = useState(null);

  // Review editing
  const [editText, setEditText] = useState('');
  const [editOptions, setEditOptions] = useState([]);
  const [versions, setVersions] = useState([]);
  const [status, setStatus] = useState('draft');

  // AI edit instruction
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiEditing, setAiEditing] = useState(false);

  // Question bank
  const [bankQuestions, setBankQuestions] = useState([]);
  const [bankClassFilter, setBankClassFilter] = useState(null); // null = all

  // Class manager
  const [newClassName, setNewClassName] = useState('');
  const [uploadStatus, setUploadStatus] = useState({}); // { [classId]: {state, message} }

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState({ used: 0, limit: 500, remaining: 500 });

  useEffect(() => {
    fetchUsage();
    fetchClasses();
  }, []);

  const fetchUsage = async () => {
    try {
      const res = await fetch(`${API}/api/usage`);
      const data = await res.json();
      setUsage(data);
    } catch (e) {
      console.error('Failed to fetch usage', e);
    }
  };

  const fetchClasses = async () => {
    try {
      const res = await fetch(`${API}/api/classes`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setClasses(data);
        if (data.length > 0) setSelectedClass(prev => prev ?? data[0]);
      }
    } catch (e) {
      console.error('Failed to fetch classes', e);
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const resetAll = () => {
    setTopic(INITIAL.topic);
    setObjective(INITIAL.objective);
    setNumDistractors(INITIAL.numDistractors);
    setQuestion(null);
    setQuestionId(null);
    setEditText('');
    setEditOptions([]);
    setVersions([]);
    setStatus('draft');
    setAiInstruction('');
    setError('');
  };

  const fetchVersions = useCallback(async (id) => {
    try {
      const res = await fetch(`${API}/api/questions/${id}/versions`);
      const data = await res.json();
      setVersions(data);
    } catch (e) {
      console.error('Failed to load versions', e);
    }
  }, []);

  const fetchBank = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/questions?in_bank=true`);
      const data = await res.json();
      setBankQuestions(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Failed to load bank', e);
    }
  }, []);

  // ── Class manager helpers ─────────────────────────────────────────────────

  const handleAddClass = async () => {
    if (!newClassName.trim()) return;
    try {
      const res = await fetch(`${API}/api/classes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newClassName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setClasses(prev => [...prev, data]);
      setNewClassName('');
    } catch (e) {
      setError(e.message);
    }
  };

  const extractTextFromFile = async (file) => {
    const buffer = await file.arrayBuffer();
    if (file.name.endsWith('.pdf')) {
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      const pages = await Promise.all(
        Array.from({ length: pdf.numPages }, (_, i) =>
          pdf.getPage(i + 1).then(p => p.getTextContent()).then(tc =>
            tc.items.map(it => it.str).join(' ')
          )
        )
      );
      return pages.join('\n');
    } else if (file.name.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      return result.value;
    }
    throw new Error('Unsupported file type. Please upload a PDF or DOCX.');
  };

  const handleFileUpload = async (classId, file, source) => {
    setUploadStatus(prev => ({ ...prev, [classId]: { state: 'uploading', message: `Parsing ${file.name}...` } }));
    try {
      const text = await extractTextFromFile(file);
      setUploadStatus(prev => ({ ...prev, [classId]: { state: 'uploading', message: 'Uploading to database...' } }));
      const res = await fetch(`${API}/api/classes/${classId}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source, filename: file.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUploadStatus(prev => ({ ...prev, [classId]: { state: 'done', message: `✓ ${data.chunks_added} chunks added from "${file.name}"` } }));
    } catch (e) {
      setUploadStatus(prev => ({ ...prev, [classId]: { state: 'error', message: `Error: ${e.message}` } }));
    }
  };

  const enterReview = (saved) => {
    setEditText(saved.question_text);
    setEditOptions(saved.options ?? []);
    setStatus(saved.status);
    fetchVersions(saved.id);
    setView('review');
  };

  const fmt = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // ── API calls ────────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!topic.trim()) { setError('Please enter a topic'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic, objective, format,
          num_distractors: numDistractors,
          class_id: selectedClass?.id ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setQuestion(data);
      setView('ai-question');
      fetchUsage();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRegenerate = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic, objective, format,
          num_distractors: numDistractors,
          class_id: selectedClass?.id ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setQuestion(data);
      fetchUsage();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAndReview = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic, objective, format,
          num_distractors: numDistractors,
          question_text: question.question_text,
          options: question.options,
          explanation: question.explanation,
          class_id: selectedClass?.id ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setQuestionId(data.id);
      enterReview(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!questionId) return;
    setError('');
    try {
      const res = await fetch(`${API}/api/questions/${questionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_text: editText, options: editOptions, explanation: question?.explanation ?? '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setQuestion(prev => ({ ...prev, question_text: data.question_text, options: data.options }));
      fetchVersions(questionId);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleAIEdit = async () => {
    if (!aiInstruction.trim() || !questionId) return;
    setAiEditing(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/questions/${questionId}/ai-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: aiInstruction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEditText(data.question_text);
      setEditOptions(data.options ?? []);
      setQuestion(prev => ({ ...prev, question_text: data.question_text, options: data.options, explanation: data.explanation }));
      setAiInstruction('');
      fetchVersions(questionId);
      fetchUsage();
    } catch (e) {
      setError(e.message);
    } finally {
      setAiEditing(false);
    }
  };

  const handleRevert = async (versionId) => {
    if (!questionId) return;
    try {
      const res = await fetch(`${API}/api/questions/${questionId}/revert/${versionId}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEditText(data.question_text);
      setEditOptions(data.options ?? []);
      setQuestion(prev => ({ ...prev, question_text: data.question_text, options: data.options }));
      fetchVersions(questionId);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleApprove = async () => {
    if (!questionId) return;
    setError('');
    try {
      await fetch(`${API}/api/questions/${questionId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });
      await fetch(`${API}/api/questions/${questionId}/bank`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ in_bank: true }),
      });
      await fetchBank();
      resetAll();
      setView('bank');
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDeleteFromBank = async (id) => {
    try {
      await fetch(`${API}/api/questions/${id}`, { method: 'DELETE' });
      setBankQuestions(prev => prev.filter(q => q.id !== id));
    } catch (e) {
      setError(e.message);
    }
  };

  // ── Views ────────────────────────────────────────────────────────────────────

  const renderSection = () => {
    switch (view) {

      case 'dashboard':
        return (
          <section id="dashboard" className="panel">
            <h2>Instructor Dashboard</h2>
            <button onClick={() => setView('generation')}>Generate Question with AI</button>
          </section>
        );

      case 'classes':
        return (
          <section id="classes">
            <h2>Manage Classes</h2>
            {error && <p className="error">{error}</p>}

            {/* Add new class */}
            <div className="class-add-box">
              <h3>Add New Class</h3>
              <div className="action-row">
                <input
                  type="text"
                  value={newClassName}
                  onChange={e => setNewClassName(e.target.value)}
                  placeholder="e.g. EECS 281"
                  onKeyDown={e => e.key === 'Enter' && handleAddClass()}
                />
                <button onClick={handleAddClass} disabled={!newClassName.trim()}>Add Class</button>
              </div>
            </div>

            {/* Existing classes */}
            <h3 style={{ marginTop: '2rem' }}>Existing Classes</h3>
            {classes.length === 0
              ? <p className="muted">No classes yet.</p>
              : classes.map(cls => (
                <div key={cls.id} className="class-card">
                  <h4>{cls.name}</h4>

                  <div className="upload-row">
                    <label className="upload-label">
                      Upload Lecture Slide
                      <input type="file" accept=".pdf,.docx" style={{ display: 'none' }}
                        onChange={e => {
                          const file = e.target.files[0];
                          if (file) handleFileUpload(cls.id, file, 'lecture');
                          e.target.value = '';
                        }}
                      />
                    </label>

                    <label className="upload-label">
                      Upload Exam / Solution
                      <input type="file" accept=".pdf,.docx" style={{ display: 'none' }}
                        onChange={e => {
                          const file = e.target.files[0];
                          if (file) handleFileUpload(cls.id, file, 'exam');
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>

                  {uploadStatus[cls.id] && (
                    <p className={
                      uploadStatus[cls.id].state === 'done' ? 'upload-done' :
                      uploadStatus[cls.id].state === 'error' ? 'error' : 'muted'
                    }>
                      {uploadStatus[cls.id].message}
                    </p>
                  )}
                </div>
              ))
            }
          </section>
        );

      case 'generation':
        return (
          <section id="generation">
            <h2>Configure Question Generation</h2>
            {error && <p className="error">{error}</p>}
            <form onSubmit={e => { e.preventDefault(); handleGenerate(); }}>
              <label>Class<br />
                <select
                  value={selectedClass?.id ?? ''}
                  onChange={e => {
                    const cls = classes.find(c => c.id === Number(e.target.value));
                    setSelectedClass(cls ?? null);
                  }}
                >
                  <option value=''>— No class (general) —</option>
                  {classes.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              {selectedClass && CLASS_DESCRIPTIONS[selectedClass.name] && (
                <p className="muted" style={{ marginTop: '-0.5rem', marginBottom: '1rem' }}>
                  {CLASS_DESCRIPTIONS[selectedClass.name]}
                </p>
              )}
              <br />
              <label>Topic<br />
                <input type="text" value={topic} onChange={e => setTopic(e.target.value)}
                  placeholder="e.g. TCP congestion control" />
              </label><br />
              <label>Learning Objective<br />
                <input type="text" value={objective} onChange={e => setObjective(e.target.value)}
                  placeholder="e.g. Explain how the congestion window shrinks when packets are dropped" />
              </label><br />
              <label>Number of distractors<br />
                <input type="number" min="1" max="5" value={numDistractors}
                  onChange={e => setNumDistractors(Number(e.target.value))} />
              </label><br />
              <button type="submit" disabled={loading}>
                {loading ? 'Generating...' : 'Generate Draft Question'}
              </button>
            </form>
          </section>
        );

      case 'ai-question':
        return (
          <section id="ai-question">
            <h2>AI Generated Question</h2>
            {error && <p className="error">{error}</p>}
            {question && (
              <div className="question">
                <p>{question.question_text}</p>
                <ul>
                  {question.options.map((opt, i) => (
                    <li key={i}>
                      <input type="radio" name="option" readOnly />
                      {' '}{opt.text}{opt.is_correct && <strong> ✓</strong>}
                    </li>
                  ))}
                </ul>
                <details>
                  <summary>AI Explanation</summary>
                  <p>{question.explanation}</p>
                </details>
                <div className="action-row">
                  <button onClick={handleSaveAndReview} disabled={loading}>
                    {loading ? 'Saving...' : 'Edit in Review'}
                  </button>
                  <button onClick={handleRegenerate} disabled={loading}>
                    {loading ? 'Generating...' : 'Regenerate'}
                  </button>
                </div>
              </div>
            )}
          </section>
        );

      case 'review':
        return (
          <section id="review">
            <h2>Question Review</h2>
            {error && <p className="error">{error}</p>}

            <div className="review-status">
              <span className={status === 'draft' ? 'status-active' : ''}>Draft</span>
              <span className="arrow">▶</span>
              <span className={status === 'approved' ? 'status-active' : ''}>Approved</span>
            </div>

            <div className="review-body">
              <div className="review-left">
                <label><strong>Question text</strong></label>
                <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={5} />

                {editOptions.length > 0 && (
                  <>
                    <label><strong>Distractor editing</strong></label>
                    {editOptions.map((opt, i) => (
                      <textarea key={i} value={opt.text} rows={2}
                        onChange={e => {
                          const updated = editOptions.map((o, idx) =>
                            idx === i ? { ...o, text: e.target.value } : o);
                          setEditOptions(updated);
                        }}
                      />
                    ))}
                  </>
                )}

                <div className="action-row">
                  <button onClick={handleSaveEdit}>Save Edits</button>
                  <button className="btn-approve" onClick={handleApprove}>Approve</button>
                </div>

                <div className="ai-edit-box">
                  <label><strong>Ask AI to revise</strong></label>
                  <textarea
                    value={aiInstruction}
                    onChange={e => setAiInstruction(e.target.value)}
                    rows={3}
                    placeholder="e.g. Make the distractors more similar to the correct answer"
                  />
                  <button className="btn-ai" onClick={handleAIEdit} disabled={aiEditing || !aiInstruction.trim()}>
                    {aiEditing ? 'AI is revising...' : 'Apply AI Edit'}
                  </button>
                </div>
              </div>

              <div className="review-right">
                <strong>Version History</strong>
                {versions.length === 0
                  ? <p className="muted">No versions yet</p>
                  : (
                    <ul className="version-list">
                      {versions.map(v => (
                        <li key={v.id}>
                          <span>{fmt(v.created_at)}</span>
                          <span className="muted">{v.author}</span>
                          <button onClick={() => handleRevert(v.id)}>Revert</button>
                        </li>
                      ))}
                    </ul>
                  )
                }
              </div>
            </div>
          </section>
        );

      case 'bank': {
        // Group questions by class
        const classMap = {};
        bankQuestions.forEach(q => {
          const key = q.class_id ?? 0;
          if (!classMap[key]) classMap[key] = [];
          classMap[key].push(q);
        });

        const getClassName = (id) => {
          if (!id) return 'General';
          return classes.find(c => c.id === id)?.name ?? `Class ${id}`;
        };

        const folders = Object.keys(classMap).sort((a, b) => Number(a) - Number(b));
        const filtered = bankClassFilter !== null
          ? bankQuestions.filter(q => (q.class_id ?? 0) === bankClassFilter)
          : bankQuestions;

        return (
          <section id="bank">
            <h2>Question Bank</h2>
            {error && <p className="error">{error}</p>}
            <button className="btn-new" onClick={() => { resetAll(); setView('generation'); }}>
              + Generate a New Question
            </button>

            {/* Folder tabs */}
            {folders.length > 0 && (
              <div className="bank-tabs">
                <button
                  className={bankClassFilter === null ? 'tab-active' : ''}
                  onClick={() => setBankClassFilter(null)}
                >
                  All ({bankQuestions.length})
                </button>
                {folders.map(key => (
                  <button
                    key={key}
                    className={bankClassFilter === Number(key) ? 'tab-active' : ''}
                    onClick={() => setBankClassFilter(Number(key))}
                  >
                    {getClassName(Number(key))} ({classMap[key].length})
                  </button>
                ))}
              </div>
            )}

            {filtered.length === 0
              ? <p className="muted" style={{ marginTop: '1rem' }}>No approved questions yet.</p>
              : filtered.map(q => (
                <div key={q.id} className="bank-item">
                  <div className="bank-meta">
                    <span className="bank-class-tag">{getClassName(q.class_id)}</span>
                    <span>{q.topic}</span>
                  </div>
                  <p>{q.question_text}</p>
                  {q.options && q.options.length > 0 && (
                    <ul style={{ marginBottom: '0.5rem' }}>
                      {q.options.map((opt, i) => (
                        <li key={i} style={{ color: opt.is_correct ? '#28a745' : 'inherit', fontWeight: opt.is_correct ? 'bold' : 'normal' }}>
                          {opt.text} {opt.is_correct && '✓'}
                        </li>
                      ))}
                    </ul>
                  )}
                  <button className="btn-delete" onClick={() => handleDeleteFromBank(q.id)}>Delete</button>
                </div>
              ))
            }
          </section>
        );
      }

      default:
        return null;
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>ExamOps</h1>
        <nav>
          <ul>
            <li><button onClick={() => setView('dashboard')}>Dashboard</button></li>
            <li><button onClick={() => setView('generation')}>Generate</button></li>
            <li><button onClick={() => setView('ai-question')} disabled={!question} title={!question ? 'Generate a question first' : ''}>AI Question</button></li>
            <li><button onClick={() => setView('review')} disabled={!questionId} title={!questionId ? 'Save a question to review first' : ''}>Review</button></li>
            <li><button onClick={() => { fetchBank(); setView('bank'); }}>Question Bank</button></li>
            <li><button onClick={() => { setError(''); setView('classes'); }}>Manage Classes</button></li>
          </ul>
        </nav>
      </header>
      <main>
        {renderSection()}
      </main>
      <footer>
        <p>&copy; 2026 ExamOps — Hillary Luan, Sydney Shanahan, Garv Shah, Prakhar Gupta, Donghua Zhang</p>
      </footer>
      <div className="usage-badge" title={`${usage.used} / ${usage.limit} API calls used`}>
        AI calls left: <strong>{usage.remaining}</strong>
      </div>
    </div>
  );
}

export default App;
