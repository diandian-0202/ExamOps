import { useState, useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import './App.css';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  `${process.env.PUBLIC_URL}/pdf.worker.min.js`;

//const API = 'http://localhost:8787'; // 本地开发
const API = 'https://examops-backend.moral-study-dh.workers.dev';

const INITIAL = {
  topic: '', objective: '', numDistractors: 4,
};

// ── Student generation helpers ────────────────────────────────────────────────

function distributeLevels(n) {
  if (n <= 0) return [];
  if (n === 1) return ['average'];
  if (n === 2) return ['strong', 'weak'];
  const strong = Math.max(1, Math.round(n * 0.2));
  const weak   = Math.max(1, Math.round(n * 0.2));
  const avg    = Math.max(0, n - strong - weak);
  return [
    ...Array(strong).fill('strong'),
    ...Array(avg).fill('average'),
    ...Array(weak).fill('weak'),
  ];
}


const DEFAULT_PROMPTS = {
  strong:  'You are a strong student with an excellent grasp of all course material. You answer questions confidently and correctly, and can explain advanced concepts clearly.',
  average: 'You are an average student with a reasonable understanding of most course material. You answer correctly about two-thirds of the time and sometimes confuse related concepts.',
  weak:    'You are a struggling student with limited understanding of the course material. You often confuse fundamental concepts and may guess on harder questions.',
};

const CLASS_DESCRIPTIONS = {
  'EECS 485': 'Web System — covers web infrastructure, search engines, social networks, and large-scale data processing.',
  'EECS 370': 'Introduction to Computer Organization — covers assembly, memory hierarchy, pipelines, and computer architecture.',
};

const CLASS_PLACEHOLDERS = {
  'EECS 485': {
    topic: 'e.g. PageRank algorithm',
    objective: 'e.g. Explain how PageRank iteratively computes importance scores using link structure',
  },
  'EECS 370': {
    topic: 'e.g. Pipeline hazards',
    objective: 'e.g. Explain how data hazards are resolved using forwarding in a 5-stage pipeline',
  },
  default: {
    topic: 'e.g. TCP congestion control',
    objective: 'e.g. Explain how the congestion window shrinks when packets are dropped',
  },
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
  const [kcDraft, setKcDraft] = useState({}); // { [classId]: { name, description, aliases } }

  // Manage Students
  const [studentClassId, setStudentClassId] = useState(null);
  const [studentCount, setStudentCount] = useState(10);
  const [studentPrompt, setStudentPrompt] = useState('');
  const [students, setStudents] = useState({}); // { [classId]: [...] }
  const [editingStudentId, setEditingStudentId] = useState(null);
  const [studentEdits, setStudentEdits] = useState({});

  // Difficulty Evaluation
  const [evalResults, setEvalResults] = useState(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [reviewDifficultyLabel, setReviewDifficultyLabel] = useState('');

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
    setEvalResults(null);
    setReviewDifficultyLabel('');
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

  const handleAddKC = async (classId) => {
    const draft = kcDraft[classId] || {};
    if (!draft.name?.trim()) return;
    try {
      const res = await fetch(`${API}/api/classes/${classId}/kc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          description: draft.description?.trim() || '',
          aliases: draft.aliases ? draft.aliases.split(',').map(a => a.trim()).filter(Boolean) : [],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setClasses(prev => prev.map(c => c.id === classId ? { ...c, kcs: [...(c.kcs || []), data] } : c));
      setKcDraft(prev => ({ ...prev, [classId]: { name: '', description: '', aliases: '' } }));
    } catch (e) { setError(e.message); }
  };

  const handleDeleteKC = async (classId, kcId) => {
    try {
      await fetch(`${API}/api/classes/${classId}/kc/${kcId}`, { method: 'DELETE' });
      setClasses(prev => prev.map(c => c.id === classId
        ? { ...c, kcs: (c.kcs || []).filter(k => k.id !== kcId) } : c));
    } catch (e) { setError(e.message); }
  };

  // ── Student handlers ──────────────────────────────────────────────────────

  const fetchStudents = async (classId) => {
    try {
      const res = await fetch(`${API}/api/classes/${classId}/students`);
      const data = await res.json();
      setStudents(prev => ({ ...prev, [classId]: Array.isArray(data) ? data : [] }));
    } catch (e) {
      console.error('Failed to fetch students', e);
    }
  };

  const handleGenerateStudents = async () => {
    if (!studentClassId) return;
    const levels = distributeLevels(studentCount);
    const profiles = levels.map((level, i) => ({
      name: `Student ${i + 1}`,
      level,
      prompt: studentPrompt.trim() || DEFAULT_PROMPTS[level],
      assignedKnowledgeComponents: [], // instructor assigns KCs manually per student
    }));
    try {
      const res = await fetch(`${API}/api/classes/${studentClassId}/students/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ students: profiles }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStudents(prev => ({ ...prev, [studentClassId]: data }));
    } catch (e) {
      setError(e.message);
    }
  };

  const handleSaveStudent = async (classId, studentId) => {
    const s = (students[classId] || []).find(x => x.id === studentId);
    if (!s) return;
    const payload = {
      name: studentEdits.name ?? s.name,
      level: studentEdits.level ?? s.level,
      prompt: studentEdits.prompt ?? s.prompt,
      assignedKnowledgeComponents: studentEdits.assignedKnowledgeComponents ?? s.assigned_kcs,
    };
    try {
      const res = await fetch(`${API}/api/classes/${classId}/students/${studentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStudents(prev => ({
        ...prev,
        [classId]: prev[classId].map(x => x.id === studentId ? data : x),
      }));
      setEditingStudentId(null);
      setStudentEdits({});
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDeleteStudent = async (classId, studentId) => {
    try {
      await fetch(`${API}/api/classes/${classId}/students/${studentId}`, { method: 'DELETE' });
      setStudents(prev => ({
        ...prev,
        [classId]: prev[classId].filter(x => x.id !== studentId),
      }));
    } catch (e) {
      setError(e.message);
    }
  };

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

  const extractTextFromFile = async (file, onProgress) => {
    const buffer = await file.arrayBuffer();
    if (file.name.endsWith('.pdf')) {
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      const texts = [];
      let lastPageErr = null;
      for (let i = 1; i <= pdf.numPages; i++) {
        try {
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          texts.push(tc.items.filter(it => 'str' in it).map(it => it.str).join(' '));
        } catch (pageErr) {
          lastPageErr = pageErr;
          console.error(`[PDF page ${i} error]`, pageErr);
        }
        if (onProgress) onProgress(Math.round((i / pdf.numPages) * 100));
      }
      const result = texts.join('\n');
      if (!result.trim()) {
        if (lastPageErr) throw lastPageErr;
        throw new Error('No text found — this may be a scanned/image-based PDF with no text layer.');
      }
      return { text: result, pages: pdf.numPages };
    } else if (file.name.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      if (!result.value.trim()) throw new Error('No text found in the DOCX file.');
      return { text: result.value, pages: null };
    }
    throw new Error('Unsupported file type. Please upload a PDF or DOCX.');
  };

  const handleFileUpload = async (classId, files, source) => {
    const fileList = Array.from(files);
    let totalChunks = 0;
    let allMappings = null;
    let totalUnmatched = 0;
    for (let fi = 0; fi < fileList.length; fi++) {
      const file = fileList[fi];
      const prefix = fileList.length > 1 ? `[${fi + 1}/${fileList.length}] ` : '';
      flushSync(() => {
        setUploadStatus(prev => ({ ...prev, [classId]: { state: 'uploading', message: `${prefix}Parsing "${file.name}"...`, percent: 0 } }));
      });
      try {
        const { text, pages } = await extractTextFromFile(file, (percent) => {
          flushSync(() => {
            setUploadStatus(prev => ({ ...prev, [classId]: { state: 'uploading', message: `${prefix}Parsing... ${percent}%`, percent } }));
          });
        });
        const parsedMsg = pages ? `${prefix}✓ Parsed ${pages} pages. Uploading...` : `${prefix}✓ Parsed. Uploading...`;
        setUploadStatus(prev => ({ ...prev, [classId]: { state: 'uploading', message: parsedMsg, percent: null } }));
        const res = await fetch(`${API}/api/classes/${classId}/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, source, filename: file.name }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        totalChunks += data.chunks_added;
        // Accumulate KC mappings across files
        if (data.componentMappings?.length > 0) {
          allMappings = allMappings || {};
          for (const m of data.componentMappings) {
            if (!allMappings[m.component]) allMappings[m.component] = 0;
            allMappings[m.component] += m.matches.length;
          }
        }
        if (data.unmatched) totalUnmatched += data.unmatched;
      } catch (e) {
        console.error(`[Upload error] file=${file.name}`, e);
        setUploadStatus(prev => ({ ...prev, [classId]: { state: 'error', message: `${prefix}Error: ${e.message}` } }));
        return;
      }
    }
    let summary = fileList.length > 1
      ? `✓ ${fileList.length} files uploaded, ${totalChunks} chunks added`
      : `✓ ${totalChunks} chunks added from "${fileList[0].name}"`;
    if (allMappings && Object.keys(allMappings).length > 0) {
      const kcSummary = Object.entries(allMappings).map(([k, v]) => `${k} (${v})`).join(', ');
      summary += ` · Matched: ${kcSummary}`;
      if (totalUnmatched > 0) summary += ` · Unmatched: ${totalUnmatched}`;
    }
    setUploadStatus(prev => ({ ...prev, [classId]: { state: 'done', message: summary } }));
    fetchClasses(); // 刷新 chunk_count
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
      setEvalResults(null); // reset previous evaluation when new question generated
      setView('ai-question');
      fetchUsage();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRunEvaluation = async () => {
    if (!question || !selectedClass) return;
    setEvalLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: {
            question_text: question.question_text,
            options: question.options,
            topic,
            objective,
          },
          classId: selectedClass.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEvalResults(data);
      fetchUsage();
    } catch (e) {
      setError(e.message);
    } finally {
      setEvalLoading(false);
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
          difficulty: evalResults?.difficultyLabel || 'Unrated',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setReviewDifficultyLabel(data.difficulty || evalResults?.difficultyLabel || 'Unrated');
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h4 style={{ margin: 0 }}>{cls.name}</h4>
                    <button className="btn-delete" onClick={async () => {
                      await fetch(`${API}/api/classes/${cls.id}`, { method: 'DELETE' });
                      setClasses(prev => prev.filter(c => c.id !== cls.id));
                    }}>Delete</button>
                  </div>

                  <div className="upload-row">
                    <label className="upload-label">
                      Upload Lecture Slide
                      <input type="file" accept=".pdf,.docx" multiple style={{ display: 'none' }}
                        onChange={e => {
                          if (e.target.files.length > 0) handleFileUpload(cls.id, e.target.files, 'lecture');
                          e.target.value = '';
                        }}
                      />
                    </label>

                    <label className="upload-label">
                      Upload Exam / Solution
                      <input type="file" accept=".pdf,.docx" multiple style={{ display: 'none' }}
                        onChange={e => {
                          if (e.target.files.length > 0) handleFileUpload(cls.id, e.target.files, 'exam');
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>

                  {uploadStatus[cls.id] && (
                    <div>
                      <p className={
                        uploadStatus[cls.id].state === 'done' ? 'upload-done' :
                        uploadStatus[cls.id].state === 'error' ? 'error' : 'muted'
                      } style={{ marginBottom: '0.25rem' }}>
                        {uploadStatus[cls.id].message}
                      </p>
                      {uploadStatus[cls.id].state === 'uploading' && uploadStatus[cls.id].percent != null && (
                        <div className="progress-bar-wrap">
                          <div className="progress-bar-fill" style={{ width: `${uploadStatus[cls.id].percent}%` }} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Knowledge Components */}
                  <div className="kc-section">
                    <strong>Knowledge Components</strong>
                    {(cls.kcs || []).length > 0 && (
                      <ul className="kc-list">
                        {(cls.kcs || []).map(kc => (
                          <li key={kc.id} className="kc-item">
                            <div className="kc-item-header">
                              <span className="kc-name">
                                {kc.name}
                                {kc.chunk_count > 0 && (
                                  <span style={{ color: '#28a745', marginLeft: '0.4rem', fontSize: '0.85rem' }}>
                                    ✓ {kc.chunk_count} chunks
                                  </span>
                                )}
                              </span>
                              <button className="btn-delete" onClick={() => handleDeleteKC(cls.id, kc.id)}>✕</button>
                            </div>
                            {kc.description && <p className="muted" style={{ margin: '0.15rem 0' }}>{kc.description}</p>}
                            {kc.aliases?.length > 0 && (
                              <p className="muted" style={{ margin: 0 }}>
                                Keywords: {kc.aliases.join(', ')}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="kc-add-form">
                      <input type="text" placeholder="Component name (e.g. SQL JOIN)"
                        value={kcDraft[cls.id]?.name || ''}
                        onChange={e => setKcDraft(prev => ({ ...prev, [cls.id]: { ...prev[cls.id], name: e.target.value } }))}
                      />
                      <input type="text" placeholder="Description (optional)"
                        value={kcDraft[cls.id]?.description || ''}
                        onChange={e => setKcDraft(prev => ({ ...prev, [cls.id]: { ...prev[cls.id], description: e.target.value } }))}
                      />
                      <input type="text" placeholder="Aliases / keywords, comma-separated (optional)"
                        value={kcDraft[cls.id]?.aliases || ''}
                        onChange={e => setKcDraft(prev => ({ ...prev, [cls.id]: { ...prev[cls.id], aliases: e.target.value } }))}
                      />
                      <button onClick={() => handleAddKC(cls.id)} disabled={!kcDraft[cls.id]?.name?.trim()}>
                        + Add Component
                      </button>
                    </div>
                  </div>
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
                  placeholder={(CLASS_PLACEHOLDERS[selectedClass?.name] ?? CLASS_PLACEHOLDERS.default).topic} />
              </label><br />
              <label>Learning Objective<br />
                <input type="text" value={objective} onChange={e => setObjective(e.target.value)}
                  placeholder={(CLASS_PLACEHOLDERS[selectedClass?.name] ?? CLASS_PLACEHOLDERS.default).objective} />
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
                  <button onClick={() => setView('evaluation')} disabled={loading}>
                    Eval Difficulty
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
              {reviewDifficultyLabel && (
                <span className={`difficulty-badge difficulty-${reviewDifficultyLabel}`} style={{ fontSize: '0.8rem', padding: '0.1rem 0.6rem', marginLeft: '0.5rem' }}>
                  {reviewDifficultyLabel}
                </span>
              )}
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
                    {q.difficulty && !['Common Mistakes', 'Unrated', ''].includes(q.difficulty) && (
                      <span className={`difficulty-badge difficulty-${q.difficulty}`} style={{ fontSize: '0.72rem', padding: '0.05rem 0.5rem' }}>
                        {q.difficulty}
                      </span>
                    )}
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

      case 'evaluation': {
        const OUTCOME_LABEL = { correct: '✓ Correct', incorrect: '✗ Incorrect', unfamiliar: '~ Unfamiliar', error: '! Error' };
        const OUTCOME_CLASS = { correct: 'outcome-correct', incorrect: 'outcome-incorrect', unfamiliar: 'outcome-unfamiliar', error: 'outcome-error' };

        return (
          <section id="evaluation">
            <h2>Difficulty Evaluation</h2>
            {error && <p className="error">{error}</p>}

            {/* Question summary */}
            <div className="eval-question-box">
              <p className="muted" style={{ margin: '0 0 0.4rem' }}>
                Topic: <strong>{topic || '—'}</strong>
                {selectedClass && <span style={{ marginLeft: '1rem' }}>Class: <strong>{selectedClass.name}</strong></span>}
              </p>
              <p style={{ margin: 0 }}>{question.question_text}</p>
            </div>

            {/* Action buttons */}
            <div className="action-row" style={{ marginBottom: '1.5rem' }}>
              {selectedClass
                ? (
                  <button onClick={handleRunEvaluation} disabled={evalLoading}>
                    {evalLoading ? 'Running simulation…' : 'Run Student Simulation'}
                  </button>
                )
                : <p className="muted" style={{ margin: 0 }}>Select a class with students in the Generate step first.</p>
              }
              <button onClick={handleSaveAndReview} disabled={loading || evalLoading} className="btn-approve">
                {loading ? 'Saving…' : evalResults ? `Save as ${evalResults.difficultyLabel} → Review` : 'Save & Review'}
              </button>
            </div>

            {/* Results */}
            {evalResults && (
              <>
                {/* Summary bar */}
                <div className="eval-summary">
                  <span className={`difficulty-badge difficulty-${evalResults.difficultyLabel}`}>
                    {evalResults.difficultyLabel}
                  </span>
                  <div>
                    <strong>{evalResults.correctCount} / {evalResults.total}</strong> students answered correctly
                    <span className="muted" style={{ marginLeft: '0.5rem' }}>({evalResults.score}%)</span>
                  </div>
                  <div className="muted" style={{ fontSize: '0.85rem' }}>
                    Easy ≥ 70% · Medium 30–69% · Hard &lt; 30%
                  </div>
                </div>

                {/* Per-student rows */}
                {evalResults.results.map(r => (
                  <div key={r.studentId} className="eval-result-item">
                    <div className="eval-result-left">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                        <strong>{r.studentName}</strong>
                        <span className={`level-badge level-${r.level}`}>{r.level}</span>
                        {r.familiar
                          ? <span style={{ fontSize: '0.78rem', color: '#0052d4' }}>● familiar</span>
                          : <span style={{ fontSize: '0.78rem', color: '#888' }}>○ unfamiliar</span>}
                      </div>
                      {r.assignedKCs.length > 0
                        ? <div className="student-kc-tags">{r.assignedKCs.map(n => <span key={n} className="student-kc-tag">{n}</span>)}</div>
                        : <span className="muted" style={{ fontSize: '0.8rem' }}>No KCs assigned</span>}
                    </div>
                    <div className="eval-result-right">
                      <div className={`eval-outcome ${OUTCOME_CLASS[r.outcome] || ''}`}>
                        {OUTCOME_LABEL[r.outcome] || r.outcome}
                        {r.selected && r.selected !== '?' && <span className="muted" style={{ fontWeight: 'normal', marginLeft: '0.4rem' }}>(picked {r.selected})</span>}
                      </div>
                      <p className="muted" style={{ margin: '0.3rem 0 0', fontSize: '0.85rem' }}>{r.reasoning}</p>
                    </div>
                  </div>
                ))}
              </>
            )}
          </section>
        );
      }

      case 'students': {
        const cls = classes.find(c => c.id === studentClassId);
        const kcs = cls?.kcs || [];
        const studs = students[studentClassId] || [];
        const strong  = studs.filter(s => s.level === 'strong').length;
        const average = studs.filter(s => s.level === 'average').length;
        const weak    = studs.filter(s => s.level === 'weak').length;

        return (
          <section id="students">
            <h2>Manage Students</h2>
            {error && <p className="error">{error}</p>}

            <label>Class<br />
              <select value={studentClassId ?? ''} onChange={e => {
                const id = Number(e.target.value) || null;
                setStudentClassId(id);
                if (id) fetchStudents(id);
              }}>
                <option value="">— Select a class —</option>
                {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>

            {cls && (
              <>
                {kcs.length > 0
                  ? <p className="muted" style={{ marginTop: '-0.5rem' }}>Available KCs: {kcs.map(k => k.name).join(', ')}</p>
                  : <p className="muted" style={{ marginTop: '-0.5rem' }}>No KCs defined yet — add them in Manage Classes first.</p>
                }

                {/* Generation controls */}
                <div className="student-gen-box">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: 0 }}>
                      Number of students:
                      <input type="number" min="1" max="50" value={studentCount}
                        onChange={e => setStudentCount(Math.max(1, Number(e.target.value)))}
                        style={{ width: 70, margin: 0 }} />
                    </label>
                    <button onClick={handleGenerateStudents}>
                      Generate {studentCount} Students
                    </button>
                    {studs.length > 0 && (
                      <span className="muted">(replaces existing {studs.length})</span>
                    )}
                  </div>
                  <label style={{ marginTop: '0.75rem', display: 'block' }}>
                    Custom persona prompt (optional — applied to all levels)
                    <textarea rows={3} value={studentPrompt} onChange={e => setStudentPrompt(e.target.value)}
                      placeholder={'Leave blank to use built-in prompts per level.\nExample: "You are a student who always tries to relate concepts to real-world scenarios."'} />
                  </label>
                </div>

                {/* Student list */}
                {studs.length === 0
                  ? <p className="muted">No students yet. Click Generate to create them.</p>
                  : (
                    <>
                      <p className="muted" style={{ marginBottom: '0.75rem' }}>
                        {studs.length} students &nbsp;·&nbsp;
                        <span style={{ color: '#28a745' }}>{strong} strong</span> /&nbsp;
                        <span style={{ color: '#0052d4' }}>{average} average</span> /&nbsp;
                        <span style={{ color: '#fd7e14' }}>{weak} weak</span>
                      </p>

                      {studs.map(s => (
                        <div key={s.id} className="student-item">
                          {editingStudentId === s.id ? (
                            <div className="student-edit-form">
                              <label>Name
                                <input type="text"
                                  value={studentEdits.name ?? s.name}
                                  onChange={e => setStudentEdits(p => ({ ...p, name: e.target.value }))} />
                              </label>
                              <label>Level
                                <select value={studentEdits.level ?? s.level}
                                  onChange={e => setStudentEdits(p => ({ ...p, level: e.target.value }))}>
                                  <option value="strong">Strong</option>
                                  <option value="average">Average</option>
                                  <option value="weak">Weak</option>
                                </select>
                              </label>
                              <label>Prompt
                                <textarea rows={4}
                                  value={studentEdits.prompt ?? s.prompt}
                                  onChange={e => setStudentEdits(p => ({ ...p, prompt: e.target.value }))} />
                              </label>
                              {kcs.length > 0 && (
                                <label>Assigned KCs
                                  <div className="kc-checkbox-group">
                                    {kcs.map(kc => {
                                      const current = studentEdits.assignedKnowledgeComponents ?? s.assigned_kcs;
                                      return (
                                        <label key={kc.id} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', width: 'auto', margin: 0 }}>
                                          <input type="checkbox"
                                            checked={current.includes(kc.name)}
                                            onChange={e => {
                                              const base = studentEdits.assignedKnowledgeComponents ?? [...s.assigned_kcs];
                                              setStudentEdits(p => ({
                                                ...p,
                                                assignedKnowledgeComponents: e.target.checked
                                                  ? [...base, kc.name]
                                                  : base.filter(n => n !== kc.name),
                                              }));
                                            }}
                                          />
                                          {kc.name}
                                        </label>
                                      );
                                    })}
                                  </div>
                                </label>
                              )}
                              <div className="action-row">
                                <button onClick={() => handleSaveStudent(cls.id, s.id)}>Save</button>
                                <button style={{ background: '#6c757d' }} onClick={() => { setEditingStudentId(null); setStudentEdits({}); }}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="student-header">
                                <strong>{s.name}</strong>
                                <span className={`level-badge level-${s.level}`}>{s.level}</span>
                              </div>
                              <p className="muted" style={{ margin: '0.25rem 0', fontSize: '0.85rem' }}>{s.prompt}</p>
                              {s.assigned_kcs?.length > 0 && (
                                <div className="student-kc-tags">
                                  {s.assigned_kcs.map(name => (
                                    <span key={name} className="student-kc-tag">{name}</span>
                                  ))}
                                </div>
                              )}
                              <div className="action-row" style={{ marginTop: '0.5rem' }}>
                                <button style={{ background: '#6c757d', padding: '0.3rem 0.8rem', fontSize: '0.85rem' }}
                                  onClick={() => { setEditingStudentId(s.id); setStudentEdits({}); }}>Edit</button>
                                <button className="btn-delete" onClick={() => handleDeleteStudent(cls.id, s.id)}>✕</button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </>
                  )
                }
              </>
            )}
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
            <li><button onClick={() => setView('evaluation')} disabled={!question} title={!question ? 'Generate a question first' : ''}>Difficulty Eval</button></li>
            <li><button onClick={() => setView('review')} disabled={!questionId} title={!questionId ? 'Save a question to review first' : ''}>Review</button></li>
            <li><button onClick={() => { fetchBank(); setView('bank'); }}>Question Bank</button></li>
            <li><button onClick={() => { setError(''); setView('classes'); }}>Manage Classes</button></li>
            <li><button onClick={() => {
              setError('');
              setView('students');
              // initialise class selector to first class if not set
              setStudentClassId(prev => {
                const id = prev ?? (classes[0]?.id ?? null);
                if (id) fetchStudents(id);
                return id;
              });
            }}>Students</button></li>
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
