export type WorkspaceDocument = {
    absolutePath: string;
    relativePath: string;
    content: string;
    sha256: string;
};
export declare function hashContent(content: string): string;
export declare function collectWorkspaceDocuments(workspaceDir: string): Promise<WorkspaceDocument[]>;
export declare function resolveWorkspaceDir(workspaceDir?: string): string | null;
