// mini_json.hpp - 极简 JSON 解析/序列化（无障碍、无第三方依赖）
// 仅用于本桥接的进程内协议，支持: null/bool/number/string/array/object
#pragma once

#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace mj {

inline void appendUtf8(std::string& out, unsigned int cp) {
    if (cp <= 0x7f) {
        out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7ff) {
        out.push_back(static_cast<char>(0xc0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
    } else if (cp <= 0xffff) {
        out.push_back(static_cast<char>(0xe0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
    } else {
        out.push_back(static_cast<char>(0xf0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3f)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
    }
}

inline void dumpString(std::string& out, const std::string& s) {
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    out.push_back('"');
}

class Value {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    Value() : type_(Type::Null) {}
    Value(std::nullptr_t) : type_(Type::Null) {}
    Value(bool b) : type_(Type::Bool), bool_(b) {}
    Value(int n) : type_(Type::Number), num_(static_cast<double>(n)) {}
    Value(long long n) : type_(Type::Number), num_(static_cast<double>(n)) {}
    Value(double n) : type_(Type::Number), num_(n) {}
    Value(const char* s) : type_(Type::String), str_(s ? s : "") {}
    Value(std::string s) : type_(Type::String), str_(std::move(s)) {}

    static Value array() { Value v; v.type_ = Type::Array; return v; }
    static Value object() { Value v; v.type_ = Type::Object; return v; }

    Type type() const { return type_; }
    bool isNull() const { return type_ == Type::Null; }
    bool isObject() const { return type_ == Type::Object; }
    bool isArray() const { return type_ == Type::Array; }
    bool isString() const { return type_ == Type::String; }
    bool isNumber() const { return type_ == Type::Number; }
    bool isBool() const { return type_ == Type::Bool; }

    bool asBool() const { return bool_; }
    double asNumber() const { return num_; }
    int asInt() const { return static_cast<int>(num_); }
    long long asInt64() const { return static_cast<long long>(num_); }
    const std::string& asString() const { return str_; }

    size_t size() const {
        if (type_ == Type::Array) return arr_.size();
        if (type_ == Type::Object) return keys_.size();
        return 0;
    }

    bool contains(const std::string& key) const {
        if (type_ != Type::Object) return false;
        for (const auto& k : keys_) if (k == key) return true;
        return false;
    }

    const Value& at(const std::string& key) const {
        if (type_ != Type::Object) throw std::runtime_error("json: not an object");
        for (size_t i = 0; i < keys_.size(); ++i) if (keys_[i] == key) return vals_[i];
        throw std::runtime_error("json: missing key: " + key);
    }

    Value& operator[](const std::string& key) {
        if (type_ != Type::Object) { type_ = Type::Object; keys_.clear(); vals_.clear(); }
        for (size_t i = 0; i < keys_.size(); ++i) if (keys_[i] == key) return vals_[i];
        keys_.push_back(key);
        vals_.push_back(Value());
        return vals_.back();
    }

    const std::vector<Value>& items() const { return arr_; }
    std::vector<Value>& items() { return arr_; }

    void push(Value v) {
        if (type_ != Type::Array) { type_ = Type::Array; arr_.clear(); }
        arr_.push_back(std::move(v));
    }

    std::string dump() const {
        std::string out;
        dumpTo(out);
        return out;
    }

    static Value parse(const std::string& text);

private:
    void dumpTo(std::string& out) const {
        switch (type_) {
            case Type::Null: out += "null"; break;
            case Type::Bool: out += bool_ ? "true" : "false"; break;
            case Type::Number: {
                const double n = num_;
                if (std::isfinite(n) && n == std::floor(n) && std::fabs(n) < 9.0e15) {
                    char buf[32];
                    std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(n));
                    out += buf;
                } else {
                    char buf[48];
                    std::snprintf(buf, sizeof(buf), "%.17g", n);
                    out += buf;
                }
                break;
            }
            case Type::String: dumpString(out, str_); break;
            case Type::Array: {
                out.push_back('[');
                for (size_t i = 0; i < arr_.size(); ++i) {
                    if (i) out.push_back(',');
                    arr_[i].dumpTo(out);
                }
                out.push_back(']');
                break;
            }
            case Type::Object: {
                out.push_back('{');
                for (size_t i = 0; i < keys_.size(); ++i) {
                    if (i) out.push_back(',');
                    dumpString(out, keys_[i]);
                    out.push_back(':');
                    vals_[i].dumpTo(out);
                }
                out.push_back('}');
                break;
            }
        }
    }

    Type type_;
    bool bool_ = false;
    double num_ = 0.0;
    std::string str_;
    std::vector<Value> arr_;
    std::vector<std::string> keys_;
    std::vector<Value> vals_;
};

inline Value parseJson(const std::string& text) {
    class Parser {
    public:
        explicit Parser(const std::string& t) : t_(t) {}
        Value parse() {
            skipWs();
            Value v = parseValue();
            skipWs();
            if (pos_ != t_.size()) fail("trailing characters");
            return v;
        }

    private:
        const std::string& t_;
        size_t pos_ = 0;

        [[noreturn]] void fail(const char* msg) {
            throw std::runtime_error(std::string("json parse error: ") + msg + " at " + std::to_string(pos_));
        }
        void skipWs() {
            while (pos_ < t_.size()) {
                const char c = t_[pos_];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++pos_;
                else break;
            }
        }
        char peek() { if (pos_ >= t_.size()) fail("unexpected end"); return t_[pos_]; }
        char next() { if (pos_ >= t_.size()) fail("unexpected end"); return t_[pos_++]; }
        bool consume(char c) { if (pos_ < t_.size() && t_[pos_] == c) { ++pos_; return true; } return false; }
        void expect(char c) { if (!consume(c)) fail("unexpected character"); }

        void literal(const char* s) {
            for (const char* p = s; *p; ++p) {
                if (pos_ >= t_.size() || t_[pos_] != *p) fail("bad literal");
                ++pos_;
            }
        }

        unsigned int parseHex4() {
            unsigned int v = 0;
            for (int i = 0; i < 4; ++i) {
                const char c = next();
                v <<= 4;
                if (c >= '0' && c <= '9') v |= static_cast<unsigned int>(c - '0');
                else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned int>(c - 'a' + 10);
                else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned int>(c - 'A' + 10);
                else fail("bad \\u escape");
            }
            return v;
        }

        std::string parseString() {
            expect('"');
            std::string out;
            while (true) {
                const char c = next();
                if (c == '"') break;
                if (c != '\\') { out.push_back(c); continue; }
                const char e = next();
                switch (e) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        unsigned int cp = parseHex4();
                        if (cp >= 0xD800 && cp <= 0xDBFF &&
                            pos_ + 1 < t_.size() && t_[pos_] == '\\' && t_[pos_ + 1] == 'u') {
                            pos_ += 2;
                            const unsigned int lo = parseHex4();
                            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            } else {
                                appendUtf8(out, cp);
                                cp = lo;
                            }
                        }
                        appendUtf8(out, cp);
                        break;
                    }
                    default: fail("bad escape");
                }
            }
            return out;
        }

        Value parseNumber() {
            const size_t start = pos_;
            if (pos_ < t_.size() && (t_[pos_] == '-' || t_[pos_] == '+')) ++pos_;
            while (pos_ < t_.size()) {
                const char c = t_[pos_];
                if (std::isdigit(static_cast<unsigned char>(c)) || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') ++pos_;
                else break;
            }
            if (pos_ == start) fail("bad number");
            return Value(std::strtod(t_.substr(start, pos_ - start).c_str(), nullptr));
        }

        Value parseArray() {
            expect('[');
            Value v = Value::array();
            skipWs();
            if (consume(']')) return v;
            while (true) {
                v.push(parseValue());
                skipWs();
                if (consume(',')) continue;
                expect(']');
                break;
            }
            return v;
        }

        Value parseObject() {
            expect('{');
            Value v = Value::object();
            skipWs();
            if (consume('}')) return v;
            while (true) {
                skipWs();
                const std::string key = parseString();
                skipWs();
                expect(':');
                v[key] = parseValue();
                skipWs();
                if (consume(',')) continue;
                expect('}');
                break;
            }
            return v;
        }

        Value parseValue() {
            skipWs();
            switch (peek()) {
                case '{': return parseObject();
                case '[': return parseArray();
                case '"': return Value(parseString());
                case 't': literal("true"); return Value(true);
                case 'f': literal("false"); return Value(false);
                case 'n': literal("null"); return Value();
                default: return parseNumber();
            }
        }
    };

    Parser parser(text);
    return parser.parse();
}

inline Value Value::parse(const std::string& text) { return parseJson(text); }

}  // namespace mj
