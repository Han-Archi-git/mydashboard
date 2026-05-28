"""
mydashboard Gist API 스크립트
Claude가 자연어 명령으로 대시보드 데이터를 직접 수정한다.

조회:
  python dashboard_api.py list [카테고리명]
  python dashboard_api.py tree <프로젝트명 또는 id>

추가:
  python dashboard_api.py add-project <카테고리> <프로젝트명>
  python dashboard_api.py add-phase   <프로젝트> <단계명>
  python dashboard_api.py add-task    <프로젝트> <단계> <할일> [마감일 YYYY-MM-DD]
  python dashboard_api.py add-subitem <할일 id 또는 제목> <세부항목1> [세부항목2 ...]
        # 할일(task)을 분류 컨테이너로 쓰고 그 아래 세부 체크리스트(subItems)를 단다.
        # 같은 제목 task가 여러 개면 멈추므로 가능하면 task id로 지정.

수정/완료:
  python dashboard_api.py check    <할일 id 또는 제목> [프로젝트]
  python dashboard_api.py uncheck  <할일 id 또는 제목> [프로젝트]
  python dashboard_api.py toggle   <할일 id 또는 제목> [프로젝트]
  python dashboard_api.py check-sub   <세부항목 id 또는 텍스트> [프로젝트]
  python dashboard_api.py uncheck-sub <세부항목 id 또는 텍스트> [프로젝트]
  python dashboard_api.py memo     <할일 id 또는 제목> <메모내용>
  python dashboard_api.py due      <할일 id 또는 제목> <YYYY-MM-DD 또는 none>
  python dashboard_api.py rename   <id 또는 이름> <새이름>      # 프로젝트/단계/할일
  python dashboard_api.py delete   <id 또는 이름>               # 프로젝트/단계/할일
  python dashboard_api.py delete-sub <세부항목 id 또는 텍스트> [프로젝트]

* 이름이 여러 항목과 일치하면 후보를 보여주고 멈춘다. id(앞 8자)로 다시 지정하면 됨.
* id는 list / tree 출력에서 확인 가능.
"""

import os
import sys
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
import urllib.request
import urllib.error

# 한글 출력이 콘솔 인코딩과 무관하게 깨지지 않도록 강제
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

SCRIPT_DIR = Path(__file__).parent
ENV_FILE = SCRIPT_DIR.parent / '.env'
GIST_FILENAME = 'data.json'


def load_env():
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    env['PAT']     = os.environ.get('MYDASHBOARD_PAT')     or env.get('MYDASHBOARD_PAT', '')
    env['GIST_ID'] = os.environ.get('MYDASHBOARD_GIST_ID') or env.get('MYDASHBOARD_GIST_ID', '')
    if not env['PAT'] or not env['GIST_ID']:
        print('[오류] .env 파일에 MYDASHBOARD_PAT 와 MYDASHBOARD_GIST_ID 를 설정하세요.')
        print(f'       경로: {ENV_FILE}')
        sys.exit(1)
    return env


def gist_request(method, path, data=None, env=None):
    if env is None:
        env = load_env()
    url = f'https://api.github.com{path}'
    headers = {
        'Authorization': f"token {env['PAT']}",
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
    }
    body = json.dumps(data, ensure_ascii=False).encode('utf-8') if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print(f'[오류] GitHub API {method} {path} → {e.code}: {e.read().decode()}')
        sys.exit(1)


def get_data(env=None):
    if env is None:
        env = load_env()
    result = gist_request('GET', f"/gists/{env['GIST_ID']}", env=env)
    files = result.get('files', {})
    file = files.get(GIST_FILENAME) or next(iter(files.values()), None)
    if not file or not file.get('content'):
        return None
    return json.loads(file['content'])


def save_data(data, env=None):
    if env is None:
        env = load_env()
    data['updatedAt'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    gist_request('PATCH', f"/gists/{env['GIST_ID']}", {
        'files': {GIST_FILENAME: {'content': json.dumps(data, ensure_ascii=False, indent=2)}}
    }, env=env)


def uid():
    return str(uuid.uuid4())


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


# ---------- 탐색 ----------

def find_category(data, name_or_id):
    name_lower = name_or_id.lower()
    for c in data.get('categories', []):
        if c['id'] == name_or_id or c['name'].lower() == name_lower:
            return c
    for c in data.get('categories', []):
        if name_lower in c['name'].lower() or name_lower in c['id'].lower():
            return c
    return None


def find_project(data, project_ref):
    name_lower = project_ref.lower()
    for c in data.get('categories', []):
        for p in c.get('projects', []):
            if p['id'] == project_ref or p['id'].startswith(project_ref):
                return c, p
            if p['name'].lower() == name_lower:
                return c, p
    for c in data.get('categories', []):
        for p in c.get('projects', []):
            if name_lower in p['name'].lower():
                return c, p
    return None, None


def resolve(data, ref, kinds=('project', 'phase', 'task'), project_ref=None):
    """ref를 id 접두사 또는 이름으로 매칭. (kind, ctx, node) 목록 반환.
    id 접두사 정확 매칭이 하나라도 있으면 그것만 반환(이름 오탐 방지)."""
    ref_l = ref.lower()
    id_hits, name_hits = [], []
    proj_filter = project_ref.lower() if project_ref else None
    for c in data.get('categories', []):
        for p in c.get('projects', []):
            if proj_filter and proj_filter not in p['name'].lower() and not p['id'].startswith(project_ref):
                continue
            if 'project' in kinds:
                if p['id'].startswith(ref):
                    id_hits.append(('project', {'cat': c}, p))
                elif ref_l in p['name'].lower():
                    name_hits.append(('project', {'cat': c}, p))
            for ph in p.get('phases', []):
                if 'phase' in kinds:
                    if ph['id'].startswith(ref):
                        id_hits.append(('phase', {'cat': c, 'project': p}, ph))
                    elif ref_l in ph['name'].lower():
                        name_hits.append(('phase', {'cat': c, 'project': p}, ph))
                for t in ph.get('tasks', []):
                    if 'task' in kinds:
                        if t['id'].startswith(ref):
                            id_hits.append(('task', {'cat': c, 'project': p, 'phase': ph}, t))
                        elif ref_l in t['title'].lower():
                            name_hits.append(('task', {'cat': c, 'project': p, 'phase': ph}, t))
    return id_hits if id_hits else name_hits


def label(kind, ctx, node):
    name = node.get('name') or node.get('title')
    if kind == 'project':
        return f"[프로젝트] {ctx['cat']['name']} > {name}  (id:{node['id'][:8]})"
    if kind == 'phase':
        return f"[단계] {ctx['project']['name']} > {name}  (id:{node['id'][:8]})"
    done = '✓' if node.get('done') else '·'
    return f"[할일 {done}] {ctx['project']['name']} > {ctx['phase']['name']} > {name}  (id:{node['id'][:8]})"


def pick_one(matches, ref):
    """매칭이 정확히 하나면 반환, 아니면 후보 출력 후 종료."""
    if not matches:
        print(f"[오류] '{ref}' 와 일치하는 항목이 없습니다.")
        sys.exit(1)
    if len(matches) > 1:
        print(f"[중복] '{ref}' 와 일치하는 항목이 {len(matches)}개입니다. id로 다시 지정하세요:")
        for kind, ctx, node in matches:
            print('  - ' + label(kind, ctx, node))
        sys.exit(1)
    return matches[0]


# ---------- 명령: 조회 ----------

def cmd_list(args):
    data = get_data()
    cat_filter = args[0].lower() if args else None
    for c in data.get('categories', []):
        if cat_filter and cat_filter not in c['name'].lower() and cat_filter not in c['id'].lower():
            continue
        projects = c.get('projects', [])
        print(f"\n[{c['name']}] ({len(projects)}개)")
        for p in projects:
            phases = p.get('phases', [])
            total = sum(len(ph.get('tasks', [])) for ph in phases)
            done = sum(sum(1 for t in ph.get('tasks', []) if t.get('done')) for ph in phases)
            pct = f'{done}/{total}' if total else '-'
            print(f"  - {p['name']}  [{pct}]  id:{p['id'][:8]}")


def cmd_tree(args):
    if not args:
        print('사용법: tree <프로젝트명 또는 id>')
        sys.exit(1)
    data = get_data()
    cat, project = find_project(data, args[0])
    if not project:
        print(f"[오류] 프로젝트 '{args[0]}' 없음")
        sys.exit(1)
    print(f"[{cat['name']}] {project['name']}  (id:{project['id'][:8]})")
    for ph in project.get('phases', []):
        tasks = ph.get('tasks', [])
        done = sum(1 for t in tasks if t.get('done'))
        print(f"  └ {ph['name']}  [{done}/{len(tasks)}]  id:{ph['id'][:8]}")
        for t in tasks:
            subs = t.get('subItems', [])
            mark = '[x]' if t.get('done') else '[ ]'
            extra = []
            if subs:
                sdone = sum(1 for s in subs if s.get('done'))
                extra.append(f"{sdone}/{len(subs)}")
            if t.get('due'):
                extra.append(f"~{t['due']}")
            if t.get('memo'):
                extra.append(f"메모:{t['memo']}")
            tail = ('  ' + ' '.join(extra)) if extra else ''
            print(f"      {mark} {t['title']}{tail}  id:{t['id'][:8]}")
            for s in subs:
                smark = '[x]' if s.get('done') else '[ ]'
                print(f"          {smark} {s['text']}  id:{s['id'][:8]}")


# ---------- 명령: 추가 ----------

def cmd_add_project(args):
    if len(args) < 2:
        print('사용법: add-project <카테고리> <프로젝트명>')
        sys.exit(1)
    cat_name, project_name = args[0], args[1]
    data = get_data()
    cat = find_category(data, cat_name)
    if not cat:
        print(f"[오류] 카테고리 '{cat_name}' 없음")
        print('사용 가능:', [c['name'] for c in data['categories']])
        sys.exit(1)
    project = {'id': uid(), 'name': project_name, 'createdAt': now_iso(), 'phases': []}
    cat['projects'].append(project)
    save_data(data)
    print(f"추가 완료: [{cat['name']}] {project_name}  (id: {project['id'][:8]})")


def cmd_add_phase(args):
    if len(args) < 2:
        print('사용법: add-phase <프로젝트명 또는 id> <단계명>')
        sys.exit(1)
    project_ref, phase_name = args[0], args[1]
    data = get_data()
    cat, project = find_project(data, project_ref)
    if not project:
        print(f"[오류] 프로젝트 '{project_ref}' 없음")
        sys.exit(1)
    phase = {'id': uid(), 'name': phase_name, 'tasks': []}
    project['phases'].append(phase)
    save_data(data)
    print(f"단계 추가: [{project['name']}] > {phase_name}  (id: {phase['id'][:8]})")


def cmd_add_task(args):
    if len(args) < 3:
        print('사용법: add-task <프로젝트명> <단계명> <할일> [마감일]')
        sys.exit(1)
    project_ref, phase_ref, task_title = args[0], args[1], args[2]
    data = get_data()
    cat, project = find_project(data, project_ref)
    if not project:
        print(f"[오류] 프로젝트 '{project_ref}' 없음")
        sys.exit(1)
    phase = next((ph for ph in project['phases']
                  if ph['name'].lower() == phase_ref.lower() or ph['id'].startswith(phase_ref)), None)
    if not phase:
        print(f"[오류] 단계 '{phase_ref}' 없음")
        print('단계 목록:', [ph['name'] for ph in project['phases']])
        sys.exit(1)
    task = {
        'id': uid(),
        'title': task_title,
        'done': False,
        'memo': '',
        'due': args[3] if len(args) > 3 else None,
        'createdAt': now_iso(),
    }
    phase['tasks'].append(task)
    save_data(data)
    print(f"할일 추가: [{project['name']}] > [{phase['name']}] > {task_title}  (id: {task['id'][:8]})")


def cmd_add_subitem(args):
    if len(args) < 2:
        print('사용법: add-subitem <할일 id 또는 제목> <세부항목1> [세부항목2 ...]')
        sys.exit(1)
    task_ref, texts = args[0], args[1:]
    data = get_data()
    matches = resolve(data, task_ref, kinds=('task',))
    kind, ctx, task = pick_one(matches, task_ref)
    subs = task.setdefault('subItems', [])
    for text in texts:
        item = {'id': uid(), 'text': text, 'done': False}
        subs.append(item)
        print(f"세부항목 추가: [{ctx['phase']['name']}] > {task['title']} > {text}  (id: {item['id'][:8]})")
    save_data(data)


# ---------- 세부항목(subItem) 탐색 ----------

def resolve_subitem(data, ref, project_ref=None):
    """subItem을 id 접두사 또는 텍스트로 매칭. (cat, project, phase, task, subitem) 목록."""
    ref_l = ref.lower()
    id_hits, name_hits = [], []
    for c in data.get('categories', []):
        for p in c.get('projects', []):
            if project_ref and project_ref.lower() not in p['name'].lower() and not p['id'].startswith(project_ref):
                continue
            for ph in p.get('phases', []):
                for t in ph.get('tasks', []):
                    for s in t.get('subItems', []):
                        if s['id'].startswith(ref):
                            id_hits.append((c, p, ph, t, s))
                        elif ref_l in s['text'].lower():
                            name_hits.append((c, p, ph, t, s))
    return id_hits if id_hits else name_hits


def pick_one_sub(matches, ref):
    if not matches:
        print(f"[오류] '{ref}' 와 일치하는 세부항목이 없습니다.")
        sys.exit(1)
    if len(matches) > 1:
        print(f"[중복] '{ref}' 와 일치하는 세부항목이 {len(matches)}개입니다. id로 다시 지정하세요:")
        for c, p, ph, t, s in matches:
            print(f"  - {p['name']} > {ph['name']} > {t['title']} > {s['text']}  (id:{s['id'][:8]})")
        sys.exit(1)
    return matches[0]


# ---------- 명령: 수정/완료 ----------

def _set_done(args, value, toggle=False):
    if not args:
        print('사용법: check/uncheck/toggle <할일 id 또는 제목> [프로젝트]')
        sys.exit(1)
    data = get_data()
    project_ref = args[1] if len(args) > 1 else None
    matches = resolve(data, args[0], kinds=('task',), project_ref=project_ref)
    kind, ctx, task = pick_one(matches, args[0])
    task['done'] = (not task.get('done')) if toggle else value
    save_data(data)
    state = '완료' if task['done'] else '미완료'
    print(f"{state} 처리: {ctx['project']['name']} > {ctx['phase']['name']} > {task['title']}")


def cmd_check(args):   _set_done(args, True)
def cmd_uncheck(args): _set_done(args, False)
def cmd_toggle(args):  _set_done(args, None, toggle=True)


def _set_sub_done(args, value):
    if not args:
        print('사용법: check-sub/uncheck-sub <세부항목 id 또는 텍스트> [프로젝트]')
        sys.exit(1)
    data = get_data()
    project_ref = args[1] if len(args) > 1 else None
    matches = resolve_subitem(data, args[0], project_ref)
    c, p, ph, t, s = pick_one_sub(matches, args[0])
    s['done'] = value
    save_data(data)
    state = '완료' if value else '미완료'
    print(f"{state} 처리: {p['name']} > {ph['name']} > {t['title']} > {s['text']}")


def cmd_check_sub(args):   _set_sub_done(args, True)
def cmd_uncheck_sub(args): _set_sub_done(args, False)


def cmd_delete_sub(args):
    if not args:
        print('사용법: delete-sub <세부항목 id 또는 텍스트> [프로젝트]')
        sys.exit(1)
    data = get_data()
    project_ref = args[1] if len(args) > 1 else None
    matches = resolve_subitem(data, args[0], project_ref)
    c, p, ph, t, s = pick_one_sub(matches, args[0])
    t['subItems'].remove(s)
    save_data(data)
    print(f"세부항목 삭제: {t['title']} > {s['text']}")


def cmd_memo(args):
    if len(args) < 2:
        print('사용법: memo <할일 id 또는 제목> <메모내용>')
        sys.exit(1)
    data = get_data()
    matches = resolve(data, args[0], kinds=('task',))
    kind, ctx, task = pick_one(matches, args[0])
    task['memo'] = args[1]
    save_data(data)
    print(f"메모 수정: {task['title']} → \"{args[1]}\"")


def cmd_due(args):
    if len(args) < 2:
        print('사용법: due <할일 id 또는 제목> <YYYY-MM-DD 또는 none>')
        sys.exit(1)
    data = get_data()
    matches = resolve(data, args[0], kinds=('task',))
    kind, ctx, task = pick_one(matches, args[0])
    task['due'] = None if args[1].lower() in ('none', '없음', '-') else args[1]
    save_data(data)
    print(f"마감일 수정: {task['title']} → {task['due'] or '없음'}")


def cmd_rename(args):
    if len(args) < 2:
        print('사용법: rename <id 또는 이름> <새이름>')
        sys.exit(1)
    data = get_data()
    matches = resolve(data, args[0])
    kind, ctx, node = pick_one(matches, args[0])
    old = node.get('name') or node.get('title')
    key = 'title' if kind == 'task' else 'name'
    node[key] = args[1]
    save_data(data)
    print(f"이름 변경: ({kind}) {old} → {args[1]}")


def cmd_delete(args):
    if not args:
        print('사용법: delete <id 또는 이름>')
        sys.exit(1)
    data = get_data()
    matches = resolve(data, args[0])
    kind, ctx, node = pick_one(matches, args[0])
    name = node.get('name') or node.get('title')
    if kind == 'project':
        ctx['cat']['projects'].remove(node)
    elif kind == 'phase':
        ctx['project']['phases'].remove(node)
    else:
        ctx['phase']['tasks'].remove(node)
    save_data(data)
    print(f"삭제 완료: ({kind}) {name}")


COMMANDS = {
    'list':        cmd_list,
    'tree':        cmd_tree,
    'add-project': cmd_add_project,
    'add-phase':   cmd_add_phase,
    'add-task':    cmd_add_task,
    'add-subitem': cmd_add_subitem,
    'check':       cmd_check,
    'uncheck':     cmd_uncheck,
    'toggle':      cmd_toggle,
    'check-sub':   cmd_check_sub,
    'uncheck-sub': cmd_uncheck_sub,
    'memo':        cmd_memo,
    'due':         cmd_due,
    'rename':      cmd_rename,
    'delete':      cmd_delete,
    'delete-sub':  cmd_delete_sub,
}

if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(0)
    COMMANDS[sys.argv[1]](sys.argv[2:])
