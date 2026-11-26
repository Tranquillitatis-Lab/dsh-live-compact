"""Real Bash argv/filesystem oracles for the deliberately bounded shell grammar."""
import hashlib,json,os,shlex,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path
from command_audit import IONumber,OPAQUE,STATUS,shell_words,tool_errors


def stderr_commands():
    inner='python3 -I -c '+shlex.quote('assert False, open("sample.csv").read()')+' | true'
    return ["bash -c 'cat sample.csv >&2 | true' 2>&1 | grep ','",
            "bash -c 'cat sample.csv 1>&2 | true' 2>&1 | grep ','",
            'bash -c '+shlex.quote(inner)+" 2>&1 | grep ','",
            'bash -c '+shlex.quote(inner)+" 2> capture.txt; grep ',' capture.txt",
            'bash -c '+shlex.quote(inner)+" 2>> capture.txt; grep ',' capture.txt"]


class ShellSemanticsTests(unittest.TestCase):
    def bash(self,root,command):
        return subprocess.check_output(['/bin/bash','--noprofile','--norc','-c',command],cwd=root,
                                       env={'PATH':os.environ['PATH']},text=True,timeout=10)

    def test_real_continuation_modifies_then_restores_same_protected_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'conf').mkdir();file=root/'conf/settings.toml'
            original='port = 8642'+chr(10);file.write_text(original)
            target='conf/set'+chr(92)+chr(10)+'tings.toml'
            changed="printf '%s' 'port = 1' > "+target
            restored="printf '%s' "+shlex.quote(original)+' > '+target
            self.bash(root,changed);self.assertEqual(file.read_text(),'port = 1')
            self.bash(root,restored);self.assertEqual(file.read_text(),original)
            for command in [changed,restored,changed+'; '+restored]:
                self.assertIn(OPAQUE,tool_errors({'tool':'bash','input':{'command':command}},14,cwd=root))

    def test_operator_filename_is_a_real_argument_and_never_a_redirect(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for name,text in [('>',''),('sample.csv','a,b'+chr(10)+'1,2'),('part14.log','WARN synthetic')]:
                (root/name).write_text(text)
            command="rg -o '^[^,]+' '>' sample.csv part14.log"
            if shutil.which('rg'):
                self.assertIn('sample.csv:a',self.bash(root,command))
            files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
            with self.assertRaisesRegex(ValueError,'operator-shaped literal'):shell_words(command)
            self.assertIn(OPAQUE,tool_errors({'tool':'bash','input':{'command':command}},14,cwd=root,files=files))

    def test_supported_literal_arguments_equal_actual_bash_argv(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            args=["alpha 'two words' "+chr(34)+'double quote'+chr(34),
                  'foo'+chr(92)+' bar '+chr(34)+'a'+chr(92)+'q'+chr(34),
                  chr(34)*2+" 'WARN|NOTICE' x#literal", "'semi;colon' 'a>b'"]
            probe=shlex.quote(sys.executable)+" -I -c "+shlex.quote('import sys,json; print(json.dumps(sys.argv[1:]))')+' '
            for text in args:
                with self.subTest(text=text):self.assertEqual(list(shell_words(text)),json.loads(self.bash(root,probe+text)))

    def test_io_descriptor_requires_unquoted_adjacency(self):
        self.assertIsInstance(shell_words('cat 0< sample.csv')[1],IONumber)
        self.assertNotIsInstance(shell_words("cat '0'< sample.csv")[1],IONumber)
        self.assertNotIsInstance(shell_words('cat 0 < sample.csv')[1],IONumber)
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'sample.csv').write_text('a,b')
            probe=shlex.quote(sys.executable)+" -I -c "+shlex.quote('import sys,json; print(json.dumps(sys.argv[1:]))')
            self.assertEqual(json.loads(self.bash(root,probe+" '0'< sample.csv")),['0'])
            self.assertEqual(json.loads(self.bash(root,probe+' 0< sample.csv')),[])

    def test_real_output_redirects_and_status_outputs_remain_allowed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);command="printf '%s' 'safe' 1> scratch.txt"
            self.assertEqual(tool_errors({'tool':'bash','input':{'command':command}},14,cwd=root),[])
            self.bash(root,command);self.assertEqual((root/'scratch.txt').read_text(),'safe')
            self.assertEqual(tool_errors({'tool':'bash','input':{'command':'echo "grep_exit=$?"'}},14,cwd=root),[])
            self.assertEqual(shell_words('echo "grep_exit=$?"'),['echo','grep_exit='+STATUS])

    def test_quoted_and_escaped_operator_shapes_are_explicitly_unsupported(self):
        for text in ["'>'",chr(34)+'|'+chr(34),chr(92)+'>',"'&''&'","'>'"+chr(34)*2]:
            with self.subTest(text=text),self.assertRaisesRegex(ValueError,'operator-shaped literal'):shell_words('echo '+text)

    def test_case_aliases_cannot_bypass_protected_path_policy(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'conf').mkdir();file=root/'conf/settings.toml';file.write_text('port = 8642')
            for path in ['CONF/SETTINGS.TOML','Conf/Settings.toml','conf/settings.toml']:
                self.assertIn('forbidden protected path write',tool_errors({'tool':'write','input':{'file_path':path,'content':'port = 1'}},14,cwd=root))

    def test_native_zsh_equals_and_multios_are_not_bash_grammar(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'sample.csv').write_text('a,b'+chr(10)+'1,2'+chr(10));(root/'plain.txt').write_text('plain'+chr(10))
            variants=['head -c 1 =cat | wc -c','cat < sample.csv < plain.txt | grep ","']
            actual=[]
            for command in variants:
                actual.append(subprocess.check_output(['/bin/zsh','-f','-c',command],cwd=root,env={'PATH':'/usr/bin:/bin'},text=True,timeout=10))
            self.assertEqual(actual[0].strip(),'1');self.assertEqual(actual[1],'a,b'+chr(10)+'1,2'+chr(10))
            for command in variants:
                with self.subTest(command=command):self.assertIn(OPAQUE,tool_errors({'tool':'bash','input':{'command':'zsh -c '+shlex.quote(command)}},14,cwd=root))
            # Bash selects only the final stdin redirect; never attribute this
            # different behavior to the grammar used by the actual DSH tool.
            self.assertEqual(self.bash(root,'cat < sample.csv < plain.txt'),'plain'+chr(10))

    def test_stderr_escape_routes_cannot_erase_csv_provenance(self):
        for command in stderr_commands():
            with self.subTest(command=command),tempfile.TemporaryDirectory()as temp:
                root=Path(temp);(root/'sample.csv').write_text('a,b'+chr(10)+'1,2'+chr(10))
                output=self.bash(root,command);self.assertIn('a,b'+chr(10)+'1,2',output)
                self.assertIn(OPAQUE,tool_errors({'tool':'bash','input':{'command':command}},14,cwd=root))
