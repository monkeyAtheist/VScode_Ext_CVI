#pragma once

//#include "sources/fonctions/navigation/navigation.h"

#include <sstream>
#include <type_traits>
#include <cstdint>
#include <fstream>
#include <algorithm>
#include <cctype>
#include <iostream>
#include <unordered_map>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>
#include <math.h>
#include <ctime>
#include <iomanip>
#if defined(_WIN32)
#include <windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#include <limits.h>
#include <unistd.h>
#else // Linux (Raspberry Pi inclus)
#include <unistd.h>
#include <limits.h>
#endif

//using fs = std::filesystem::path;
using UINT32 = uint32_t;

namespace jc_utility 
{
    namespace fs = std::filesystem;

    class iniReader 
    {
        public:
            bool load(const std::string& path);  // parse tout le fichier

            bool has(const std::string& section, const std::string& key) const;

            // R�cup�re une valeur typ�e. false si introuvable ou conversion impossible.
            template<typename T>
            bool get(const std::string& section, const std::string& key, T& out) const;

            // R�cup�re ou renvoie une valeur par d�faut.
            template<typename T>
            T getOr(const std::string& section, const std::string& key, const T& def) const;

        private:
            std::unordered_map<std::string, std::unordered_map<std::string, std::string>> data_;

            static std::string trim_(std::string s);
            static std::string toLower_(std::string s);
            static bool parseBool_(const std::string& s, bool& out);

            template<typename T>
            static bool convert_(const std::string& s, T& out);

            const std::string* findValue_(const std::string& section, const std::string& key) const;
    };

    class MyString : public std::string
    {
    public:     
        using std::string::string;

        MyString& trim()
        {
            auto notSpace = [](unsigned char c) { return !std::isspace(c); };

            erase(begin(), std::find_if(begin(), end(), notSpace));
            erase(std::find_if(rbegin(), rend(), notSpace).base(), end());

            std::replace_if(begin(), end(),
                [](unsigned char c) { return std::isspace(c); },
                '_');

            return *this;
        }

        std::string toStdString() const {return *this;}

        void fromStdString(const std::string& s)
        {
			this->clear();
            this->append(s);
		}

        MyString operator+ (const std::string s)
        {
            return MyString(*this + s);
        }

        MyString operator^ (int nb)
        {
            MyString s = *this;
            MyString r;
            if (nb <= 0)  return MyString(*this);
            for (int i = 0; i < nb; ++i) 
            {
                r = (*this + s);
                s = r;          
            }
            return MyString(r);
        }

    };

    template<typename T>
    bool iniReader::convert_(const std::string& s, T& out)
    {
        if constexpr (std::is_same_v<T, std::string>) {
            out = s;
            return true;
        }
        else if constexpr (std::is_same_v<T, bool>) {
            return parseBool_(s, out);
        }
        else {
            // Simple et portable : stringstream
            // (pour int/double/float/long etc.)
            std::istringstream iss(s);
            iss >> out;

            // refuse "123abc" (doit consommer toute la string)
            if (!iss) return false;
            char c;
            if (iss >> c) return false;
            return true;
        }
    }

    template<typename T>
    bool iniReader::get(const std::string& section, const std::string& key, T& out) const
    {
        const std::string* v = findValue_(section, key);
        if (!v) return false;
        return convert_(*v, out);
    }

    template<typename T>
    T iniReader::getOr(const std::string& section, const std::string& key, const T& def) const
    {
        T tmp{};
        if (get(section, key, tmp)) return tmp;
        return def;
    }

    inline int xstoi(const std::string& s, UINT32& out)
    {
        size_t idx = 0;
        int val_l = 0;
        int idx_loop = 0;
        if (s.empty()) return -10;
		idx = s.find_first_of("xX");
        if (idx == 0) return -10;
		std::string sub = s.substr(idx + 1);
        if (sub.empty()) return -20;
        for (int i = 0; i < sub.length(); i++) {
			auto c = sub.c_str()[i];
            if (c >= 'A') val_l = c - 'A' + 10;
            else  val_l = c - '0'; 
            out += (val_l * pow(16, i));
            idx_loop++;
		}
        return 0;
	}

    inline bool parseHexU32(const std::string& s, uint32_t& out) {
        try {
            size_t pos = 0;
            unsigned long v = std::stoul(s, &pos, 0); // base 0 => accepte 0x...
            if (pos != s.size()) return false;
            out = static_cast<uint32_t>(v);
            return true;
        }
        catch (...) { return false; }
    }

    inline fs::path executable_path()
    {
#if defined(_WIN32)
        std::wstring buf(MAX_PATH, L'\0');
        DWORD len = 0;

        while (true) {
            len = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
            if (len == 0) {
                throw std::runtime_error("GetModuleFileNameW failed");
            }
            if (len < buf.size() - 1) { // OK, buffer assez grand
                buf.resize(len);
                return fs::path(buf);
            }
            // buffer trop petit -> on agrandit
            buf.resize(buf.size() * 2);
        }

#elif defined(__APPLE__)
        uint32_t size = 0;
        _NSGetExecutablePath(nullptr, &size);
        std::vector<char> buf(size);

        if (_NSGetExecutablePath(buf.data(), &size) != 0) {
            throw std::runtime_error("_NSGetExecutablePath failed");
        }

        // Canonicalise (r�sout symlinks / chemins relatifs)
        char realbuf[PATH_MAX];
        if (realpath(buf.data(), realbuf) == nullptr) {
            // si realpath �choue, on retourne le chemin brut
            return fs::path(buf.data());
        }
        return fs::path(realbuf);

#else // Linux
        std::vector<char> buf(PATH_MAX);
        ssize_t count = readlink("/proc/self/exe", buf.data(), buf.size());
        if (count <= 0) {
            throw std::runtime_error("readlink(/proc/self/exe) failed");
        }
        return fs::path(std::string(buf.data(), static_cast<size_t>(count)));
#endif
    }

    inline fs::path executable_dir()
    {
        return executable_path().parent_path();
    }

    inline std::string trim_copy(std::string s)
    {
        auto notSpace = [](unsigned char c) { return !std::isspace(c); };
        s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
        s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
        return s;
    }

    inline std::string toLower_copy(std::string s)
    {
        std::transform(s.begin(), s.end(), s.begin(),
            [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return s;
    }

    inline std::string now_timestamp()
    {
        std::time_t t = std::time(nullptr);
        std::tm tm{};

#if defined(_WIN32)
        localtime_s(&tm, &t);
#else
        localtime_r(&t, &tm);
#endif

        char buf[22]; // "YYYY-MM-DD HH:MM:SS" = 19 + '\0'
        std::strftime(buf, sizeof(buf), "%d-%m-%Y %H-%M-%S", &tm);
        return std::string(buf);
    }

    struct DateTime {
        int year, month, day, hour, minute, second;
    };

    inline DateTime now_fields()
    {
        std::time_t t = std::time(nullptr);
        std::tm tm{};
#if defined(_WIN32)
        localtime_s(&tm, &t);
#else
        localtime_r(&t, &tm);
#endif
        return {
            tm.tm_year + 1900,
            tm.tm_mon + 1,
            tm.tm_mday,
            tm.tm_hour,
            tm.tm_min,
            tm.tm_sec
        };
    }

    inline void append_error_log(const std::string& path, int code, const std::string& msg)
    {
        std::ofstream f(path, std::ios::out | std::ios::app);
        f << "[" << now_timestamp() << "] => "
            << "Error code: " << code << " | Message: " << msg << "\n";
    }

}