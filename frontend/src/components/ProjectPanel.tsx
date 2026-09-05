import { useState, useEffect } from 'react';
import { FolderOpen, Clock, FileText, Trash2, Play, Eye, MoreVertical } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import './ProjectPanel.css';

interface Project {
    id: string;
    name: string;
    fileName: string;
    lastRun: string;
    createdAt: string;
    status: 'completed' | 'failed' | 'running' | 'pending';
    duration?: string;
    lines: number;
    fileSize: number;
    thumbnail?: string;
}

export default function ProjectPanel() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedProject, setSelectedProject] = useState<Project | null>(null);
    const [activeMenu, setActiveMenu] = useState<string | null>(null);

    const fileInfo = useCNCStore((s) => s.fileInfo);
    const gcode = useCNCStore((s) => s.gcode);

    // Load projects from localStorage on mount. No demo seed (Tawfiq
    // msg 7370 — empty until the user actually uploads a G-code file).
    useEffect(() => {
        const savedProjects = localStorage.getItem('cncProjects');
        if (savedProjects) setProjects(JSON.parse(savedProjects));
    }, []);

    // When a new file is loaded into the app, add it to the project list
    // if it's not already there (matched by fileName + size).
    useEffect(() => {
        if (!fileInfo?.name) return;
        setProjects((prev) => {
            const key = `${fileInfo.name}-${fileInfo.size ?? 0}`;
            if (prev.some((p) => `${p.fileName}-${p.fileSize ?? 0}` === key)) return prev;
            const entry: Project = {
                id: `f-${Date.now()}`,
                name: fileInfo.name.replace(/\.[^.]+$/, ''),
                fileName: fileInfo.name,
                lastRun: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                status: 'pending',
                lines: gcode?.length || 0,
                fileSize: fileInfo.size ?? 0,
            };
            return [entry, ...prev];
        });
    }, [fileInfo?.name, fileInfo?.size, gcode?.length]);

    // Save projects to localStorage whenever they change
    useEffect(() => {
        if (projects.length > 0) {
            localStorage.setItem('cncProjects', JSON.stringify(projects));
        }
    }, [projects]);

    const formatDate = (dateString: string): string => {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };

    const formatFileSize = (bytes: number): string => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    };

    const getStatusColor = (status: Project['status']): string => {
        switch (status) {
            case 'completed': return 'status-completed';
            case 'failed': return 'status-failed';
            case 'running': return 'status-running';
            case 'pending': return 'status-pending';
        }
    };

    const getStatusText = (status: Project['status']): string => {
        return status.charAt(0).toUpperCase() + status.slice(1);
    };

    const handleDeleteProject = (projectId: string) => {
        setProjects(projects.filter(p => p.id !== projectId));
        if (selectedProject?.id === projectId) {
            setSelectedProject(null);
        }
        setActiveMenu(null);
    };

    const handleRunProject = (project: Project) => {
        console.log('Running project:', project.name);
        // TODO: Implement run logic
        setActiveMenu(null);
    };

    const handleViewProject = (project: Project) => {
        setSelectedProject(project);
        setActiveMenu(null);
    };

    return (
        <div className="project-panel">
            <div className="project-container">
                {/* Header */}
                <div className="project-header">
                    <div className="header-title">
                        <FolderOpen size={24} />
                        <h2>Project History</h2>
                    </div>
                    <div className="header-stats">
                        <div className="stat-item">
                            <span className="stat-label">Total Projects</span>
                            <span className="stat-value">{projects.length}</span>
                        </div>
                        <div className="stat-item">
                            <span className="stat-label">Completed</span>
                            <span className="stat-value">{projects.filter(p => p.status === 'completed').length}</span>
                        </div>
                    </div>
                </div>

                {/* Project List */}
                <div className="project-content">
                    <div className="project-list">
                        {projects.length === 0 ? (
                            <div className="empty-state">
                                <FolderOpen size={64} />
                                <h3>No Projects Yet</h3>
                                <p>Upload a G-code file from the sidebar and it'll show up here.</p>
                            </div>
                        ) : (
                            <table className="project-list-table">
                                <thead>
                                    <tr>
                                        <th></th>
                                        <th>Name</th>
                                        <th>Last run</th>
                                        <th>Status</th>
                                        <th>Lines</th>
                                        <th>Duration</th>
                                        <th>Size</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {projects.map((project) => (
                                        <tr
                                            key={project.id}
                                            className={`project-list-row ${selectedProject?.id === project.id ? 'selected' : ''}`}
                                            onClick={() => handleViewProject(project)}
                                        >
                                            <td className="plr-icon"><FileText size={14} /></td>
                                            <td className="plr-name">
                                                <div className="plr-name-main">{project.name}</div>
                                                <div className="plr-name-sub">{project.fileName}</div>
                                            </td>
                                            <td className="plr-date">
                                                <Clock size={11} /> {formatDate(project.lastRun)}
                                            </td>
                                            <td>
                                                <span className={`project-status ${getStatusColor(project.status)}`}>
                                                    <span className="status-dot" /> {getStatusText(project.status)}
                                                </span>
                                            </td>
                                            <td className="plr-num">{project.lines.toLocaleString()}</td>
                                            <td className="plr-num">{project.duration || '—'}</td>
                                            <td className="plr-num">{formatFileSize(project.fileSize)}</td>
                                            <td className="plr-actions">
                                                <button
                                                    className="action-menu-btn"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setActiveMenu(activeMenu === project.id ? null : project.id);
                                                    }}
                                                    title="Actions"
                                                >
                                                    <MoreVertical size={14} />
                                                </button>
                                                {activeMenu === project.id && (
                                                    <div className="action-menu">
                                                        <button onClick={() => handleRunProject(project)}>
                                                            <Play size={14} /> Run Again
                                                        </button>
                                                        <button onClick={() => handleViewProject(project)}>
                                                            <Eye size={14} /> View Details
                                                        </button>
                                                        <button
                                                            className="delete-btn"
                                                            onClick={() => handleDeleteProject(project.id)}
                                                        >
                                                            <Trash2 size={14} /> Delete
                                                        </button>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {/* Project Details Sidebar */}
                    {selectedProject && (
                        <div className="project-details">
                            <div className="details-header">
                                <h3>Project Details</h3>
                                <button
                                    className="close-details"
                                    onClick={() => setSelectedProject(null)}
                                >
                                    ×
                                </button>
                            </div>

                            <div className="details-content">
                                <div className="detail-section">
                                    <h4>General Information</h4>
                                    <div className="detail-row">
                                        <span className="detail-label">Project Name</span>
                                        <span className="detail-value">{selectedProject.name}</span>
                                    </div>
                                    <div className="detail-row">
                                        <span className="detail-label">File Name</span>
                                        <span className="detail-value">{selectedProject.fileName}</span>
                                    </div>
                                    <div className="detail-row">
                                        <span className="detail-label">Status</span>
                                        <span className={`detail-value ${getStatusColor(selectedProject.status)}`}>
                                            {getStatusText(selectedProject.status)}
                                        </span>
                                    </div>
                                </div>

                                <div className="detail-section">
                                    <h4>Execution Details</h4>
                                    <div className="detail-row">
                                        <span className="detail-label">Last Run</span>
                                        <span className="detail-value">
                                            {new Date(selectedProject.lastRun).toLocaleString()}
                                        </span>
                                    </div>
                                    <div className="detail-row">
                                        <span className="detail-label">Created At</span>
                                        <span className="detail-value">
                                            {new Date(selectedProject.createdAt).toLocaleString()}
                                        </span>
                                    </div>
                                    <div className="detail-row">
                                        <span className="detail-label">Duration</span>
                                        <span className="detail-value">{selectedProject.duration || 'N/A'}</span>
                                    </div>
                                </div>

                                <div className="detail-section">
                                    <h4>File Information</h4>
                                    <div className="detail-row">
                                        <span className="detail-label">Total Lines</span>
                                        <span className="detail-value">{selectedProject.lines.toLocaleString()}</span>
                                    </div>
                                    <div className="detail-row">
                                        <span className="detail-label">File Size</span>
                                        <span className="detail-value">{formatFileSize(selectedProject.fileSize)}</span>
                                    </div>
                                </div>

                                <div className="detail-actions">
                                    <button 
                                        className="btn-primary-detail"
                                        onClick={() => handleRunProject(selectedProject)}
                                    >
                                        <Play size={16} />
                                        Run Again
                                    </button>
                                    <button 
                                        className="btn-danger-detail"
                                        onClick={() => handleDeleteProject(selectedProject.id)}
                                    >
                                        <Trash2 size={16} />
                                        Delete Project
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
