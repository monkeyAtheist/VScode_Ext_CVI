#include "myUtil.h"
#include <algorithm> // Pour std::min

#define MACRO_min(a,b) (((a) < (b)) ? (a) : (b))
#define MACRO_max(a,b) (((a) > (b)) ? (a) : (b))

namespace jc_utility {

    std::string iniReader::trim_(std::string s)
    {
        auto notSpace = [](unsigned char ch) { return !std::isspace(ch); };

        s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
        s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
        return s;
    }

    std::string iniReader::toLower_(std::string s)
    {
        std::transform(s.begin(), s.end(), s.begin(),
            [](unsigned char c) { return (char)std::tolower(c); });
        return s;
    }

    bool iniReader::parseBool_(const std::string& s, bool& out)
    {
        std::string v = toLower_(trim_(s));
        if (v == "1" || v == "true" || v == "yes" || v == "on") { out = true;  return true; }
        if (v == "0" || v == "false" || v == "no" || v == "off") { out = false; return true; }
        return false;
    }

    const std::string* iniReader::findValue_(const std::string& section, const std::string& key) const
    {
        auto itS = data_.find(section);
        if (itS == data_.end()) return nullptr;
        auto itK = itS->second.find(key);
        if (itK == itS->second.end()) return nullptr;
        return &itK->second;
    }

    bool iniReader::has(const std::string& section, const std::string& key) const
    {
        return findValue_(section, key) != nullptr;
    }

    bool iniReader::load(const std::string& path)
    {
        data_.clear();

        std::ifstream f(path);
        if (!f.is_open()) return false;

        std::string line;
        std::string currentSection;

        while (std::getline(f, line))
        {
            line = trim_(line);
            if (line.empty()) continue;

            // ignore commentaires
            if (line[0] == ';' || line[0] == '#') continue;

            // Section [xxx]
            if (line.front() == '[' && line.back() == ']') {
                currentSection = trim_(line.substr(1, line.size() - 2));
                continue;
            }

            // key=value
            auto eq = line.find('=');
            if (eq == std::string::npos) continue; // ligne invalide -> ignorée

            std::string key = trim_(line.substr(0, eq));
            std::string val = trim_(line.substr(eq + 1));

            // retire commentaire en fin de ligne : "val ; comment"
            auto sc = val.find(';');
            auto hs = val.find('#');
            size_t cut = MACRO_min(
                (sc == std::string::npos ? val.size() : sc),
                (hs == std::string::npos ? val.size() : hs));

            val = trim_(val.substr(0, cut));

            if (!currentSection.empty() && !key.empty()) {
                data_[currentSection][key] = val;
            }
        }

        return true;
    }

} // namespace jc_utility
