"""Parse supplied source only. Never import or execute repository code."""
import ast
import json
import posixpath
import sys

data = json.load(sys.stdin)
path, source = data['path'], data['source']
tree = ast.parse(source, filename=path)
symbols, edges = [], []

def visit(node, parents=()):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            name = '.'.join((*parents, child.name))
            kind = 'class' if isinstance(child, ast.ClassDef) else ('method' if isinstance(node, ast.ClassDef) else 'function')
            symbols.append(dict(id=f'{path}#{name}', name=name, kind=kind, startLine=child.lineno, endLine=child.end_lineno))
            visit(child, (*parents, child.name))
        else:
            if isinstance(child, ast.ImportFrom) and child.level:
                directory = posixpath.dirname(path)
                for _ in range(child.level - 1):
                    directory = posixpath.dirname(directory)
                target = posixpath.join(directory, (child.module or '').replace('.', '/'))
                edges.append(dict(kind='IMPORTS', **{'from':path, 'to':target}))
            visit(child, parents)

visit(tree)
json.dump(dict(path=path, symbols=symbols, edges=edges), sys.stdout)
