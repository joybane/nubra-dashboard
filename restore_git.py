import os
import zlib
import sys

GIT_DIR = r"e:\Derivativesproject\nubra-dashboard\.git"

def read_git_object(sha):
    path = os.path.join(GIT_DIR, "objects", sha[:2], sha[2:])
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        data = zlib.decompress(f.read())
    obj_type_end = data.find(b' ')
    obj_type = data[:obj_type_end].decode()
    size_end = data.find(b'\x00', obj_type_end)
    size = int(data[obj_type_end+1:size_end].decode())
    return obj_type, data[size_end+1:]

def parse_tree(data):
    entries = []
    i = 0
    while i < len(data):
        mode_end = data.find(b' ', i)
        mode = data[i:mode_end].decode()
        name_end = data.find(b'\x00', mode_end)
        name = data[mode_end+1:name_end].decode()
        sha = data[name_end+1:name_end+21].hex()
        entries.append((mode, name, sha))
        i = name_end + 21
    return entries

def find_in_tree(tree_sha, path):
    parts = path.split('/')
    current_sha = tree_sha
    for part in parts:
        obj_type, data = read_git_object(current_sha)
        if obj_type != "tree":
            return None
        entries = parse_tree(data)
        found = False
        for mode, name, sha in entries:
            if name == part:
                current_sha = sha
                found = True
                break
        if not found:
            return None
    return current_sha

def restore_file(tree_sha, filepath):
    blob_sha = find_in_tree(tree_sha, filepath)
    if not blob_sha:
        print(f"Could not find {filepath} in git tree.")
        return
    
    obj_type, data = read_git_object(blob_sha)
    if obj_type != "blob":
        print(f"{filepath} is not a blob.")
        return
        
    out_path = os.path.join(r"e:\Derivativesproject\nubra-dashboard", filepath)
    with open(out_path, "wb") as f:
        f.write(data)
    print(f"Restored {filepath} from git blob {blob_sha}.")

def main():
    commit_sha = "203c7b9352ec0986e66487749c7687a975b32135"
    obj_type, data = read_git_object(commit_sha)
    if obj_type != "commit":
        print("Not a commit object.")
        return
        
    # parse tree sha from commit
    lines = data.decode().split('\n')
    tree_sha = lines[0].split(' ')[1]
    
    restore_file(tree_sha, "src/NubraBacktest.tsx")
    restore_file(tree_sha, "src/components/ChartTooltips.tsx")
    restore_file(tree_sha, "src/components/StrategyAnalysisView.tsx")

if __name__ == "__main__":
    main()
