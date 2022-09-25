// For some reason, `new Buffer()` is added to the compiled code by ncc.
// This triggers the warning "DeprecationWarning: Buffer() is deprecated due to security and usability issues."
// Until it is fixed in ncc, we workaround by suppressing the warning.
process.removeAllListeners('warning');

const os = require('os');
const fs = require('fs');
const readline = require('readline');
const scratchVM = require('scratch-vm');

// Disable vm logging. Need to be done after importing scratch-vm.
const minilog = require('minilog');
minilog.disable();

if (process.argv.length < 3) {
  process.stdout.write('ERROR: No file argument\n');
  process.exit(1);
}

if (process.argv[2] === '--version') {
  const { version } = require('./package.json');
  process.stdout.write(version + '\n');
  process.exit(0);
}

function check_scratch_file(filename) {
  const vm = new scratchVM();
  vm.start();
  vm.setTurboMode(true);

  // Block loading extensions (e.g., music)
  vm.extensionManager.loadExtensionURL = (id) => {
    process.stderr.write(
      'Not a valid Scratch file: Can not use extension ' + id + '\n'
    );
    process.exit(1);
  };

  fs.readFile(filename, function (err, data) {
    if (err) {
      process.stderr.write(err + '\n');
      process.exit(1);
    }

    vm.loadProject(data)
      .then(() => {
        process.exit(0);
      })
      .catch(function (err) {
        process.stderr.write('Not a valid Scratch file: ' + err + '\n');
        process.exit(1);
      });
  });
}

class Queue {
  constructor(data = []) {
    this._data = Array.from(data);
    this._head_ptr = 0;
  }

  get length() {
    return this._data.length - this._head_ptr;
  }

  front() {
    if (this.length === 0) {
      return null;
    }
    return this._data[this._head_ptr];
  }

  push(elm) {
    this._data.push(elm);
  }
  
  push_all(elms) {
    for (const elm of elms) {
      this._data.push(elm);
    }
  }

  shift() {
    if (this.length === 0) {
      return null;
    }
    return this._data[this._head_ptr++];
  }

  toString() {
    return this._data.slice(this._head_ptr).toString();
  }
}

function is_space(c) {
  // based on regex \s
  // no need to check for '\n' and '\r'. they are handled by readline
  return c === ' ' || c === '\t' || c === '\v' || c === '\f';
}

class InputReader {
  constructor(lines = []) {
    this.lines = new Queue(lines);
    this.current_answer = '';
    this.cur_pos = 0;
    this.ask_queue = new Queue();
  } 
  
  add_lines(lines) {
    this.lines.push_all(lines);
  }
  
  enqueue_ask(is_read_token, resolve) {
    // console.log('enqueue ask', is_read_token);
    this.ask_queue.push({ is_read_token, resolve });
  }
  
  _emit_answer(answer) {
    this.current_answer = answer;
    this.ask_queue.shift().resolve();
  }
  
  _read_token() {
    while (this.lines.length > 0) {
      const line_front = this.lines.front();
      while (this.cur_pos < line_front.length && is_space(line_front[this.cur_pos])) {
        this.cur_pos++;
      }
      if (this.cur_pos === line_front.length) {
        this.lines.shift();
        this.cur_pos = 0;
      } else {
        let nxt_pos = this.cur_pos + 1;
        while (
          nxt_pos < line_front.length &&
          !is_space(line_front[nxt_pos])
        ) {
          nxt_pos++;
        }
        const answer = line_front.substr(this.cur_pos, nxt_pos - this.cur_pos);
        // console.log(answer, line_front);
        this.cur_pos = nxt_pos;
        if (this.cur_pos === line_front.length) {
          this.cur_pos = 0;
          this.lines.shift();
        }
        return answer;
      }
    }
  }
  
  _read_line() {
    if (this.lines.length > 0) {
      const answer = this.lines.shift().substr(this.cur_pos);
      this.cur_pos = 0;
      return answer;
    }
  }
    
  try_to_answer() {
    // console.log('wth');
    let answer = this.ask_queue.front().is_read_token ? this._read_token() : this._read_line();
    // console.log('try to answer: ', answer);
    if (answer != undefined) {
      this._emit_answer(answer);
    }
  }
}

function preload_project(vm, filename) {
  return new Promise((resolve) => {
    fs.readFile(filename, function (err, data) {
      if (err) {
        process.stderr.write(err + '\n');
        process.exit(1);
      }

      vm.loadProject(data)
        .then(() => {
          for (let i = 0; i < vm.runtime.targets.length; i++) {
            vm.runtime.targets[i].visible = false;
          }
          vm.runtime.on('PROJECT_RUN_STOP', function () {
            process.exit(0);
          });
          resolve(vm);
        })
        .catch(function (err) {
          process.stderr.write('scratch-vm encountered an error: ' + err + '\n');
          process.exit(1);
        });
    });
  });
}

function prepare_read_all_input(input_reader) {
  return new Promise((resolve) => {
    let all_input = '';
    process.stdin.on('data', (data) => all_input += data);
    process.stdin.on('end', (hadError) => {
      if (hadError) {
        console.error('Error while reading input');
        process.exit(1);
      }
      const lines = all_input.split(os.EOL);
      input_reader.add_lines(lines);
      resolve(input_reader);
    });
  });
}

function prepare_readline_input(input_reader) {
  // console.log('preparing readline input');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', (text) => {
    // console.log('got line', text);
    input_reader.lines.push(text);
    if (input_reader.ask_queue.length > 0) {
      input_reader.try_to_answer();
    }
  });
  // rl.on('close', () => console.log('input closed'));
  // console.log('readline', rl);
  return input_reader;
}

function run_scratch_file(filename) {
  const consume_all_input_first = true;

  const vm = new scratchVM();

  // Hack to speeding up vm.runtime._step calls
  const real_step = vm.runtime._step.bind(vm.runtime);
  vm.runtime._step = () => {
    for (let loop_count = 0; loop_count < 5000; ++loop_count) {
      setImmediate(real_step);
    }
  };
  
  const input_reader = new InputReader();

  // Block loading extensions (e.g., music)
  vm.extensionManager.loadExtensionURL = (id) => {
    process.stderr.write(
      'scratch-vm encountered an error: Can not use extension ' + id + '\n'
    );
    process.exit(1);
  };
  vm.runtime.on('SAY', function (target, type, text) {
    text = text.toString();
    if (type === 'say') {
      process.stdout.write(text + '\n');
    } else {
      // type === 'think'
      process.stdout.write(text);
    }
  });
  vm.runtime._primitives.looks_say = (args) => {
      process.stdout.write(args.MESSAGE + '\n');
  };
  vm.runtime._primitives.looks_think = (args) => {
      process.stdout.write(args.MESSAGE);
  };

  vm.runtime._primitives.sensing_answer = () => input_reader.current_answer;
  vm.runtime._primitives.sensing_askandwait = (args, util) => {
    const question = String(args.QUESTION);
    // console.log("asked: ", question);
    if (question == null) {
      throw new Error('Question for ask and wait should not be null or undefined');
    }

    if (consume_all_input_first) {
      input_reader.enqueue_ask(question === 'read_token', () => {});
      input_reader.try_to_answer();
    } else {
      return new Promise((resolve) => {
        input_reader.enqueue_ask(question === 'read_token', resolve);
        input_reader.try_to_answer();
      });
    }
  };


  vm.start();
  vm.setTurboMode(true);

  const prepare_input = consume_all_input_first ? prepare_read_all_input : prepare_readline_input;

  Promise.all([prepare_input(input_reader), preload_project(vm, filename)])
    .then(([input_reader, vm]) => {
      // console.log(input_reader);
      vm.greenFlag();
    });

}

if (process.argv[2] === '--check') {
  if (process.argv.length < 4) {
    process.stdout.write('ERROR: No file argument\n');
    process.exit(1);
  }
  check_scratch_file(process.argv[3]);
} else {
  run_scratch_file(process.argv[2]);
}
