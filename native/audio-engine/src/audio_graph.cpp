#include "audio_graph.h"
#include "sequencer.h"
#include <algorithm>
#include <cmath>
#include <cctype>
#include <queue>
#include <unordered_map>

namespace mlh {

std::unique_ptr<AudioExecutionPlan> AudioExecutionPlan::compile(
    const AudioGraphSpec& spec, const std::function<Chain*(const std::string&)>& chainLookup,
    SequencerEngine* sequencer, int maxBlockSize, std::string& error)
{
    if (maxBlockSize <= 0) { error = "invalid block size"; return {}; }
    std::unordered_map<std::string, int> index;
    for (int i=0;i<(int)spec.nodes.size();++i) {
        const auto& n=spec.nodes[(size_t)i];
        const bool validId=!n.id.empty()&&std::all_of(n.id.begin(),n.id.end(),[](unsigned char c){return std::isalnum(c)||c=='-'||c=='_';});
        if (!validId || !index.emplace(n.id,i).second) { error="invalid or duplicate node id"; return {}; }
        if (n.kind==AudioNodeKind::vst && chainLookup(n.id)==nullptr) { error="unknown VST node: "+n.id; return {}; }
        if (n.kind==AudioNodeKind::input && n.id!="audio-input") { error="invalid input node id"; return {}; }
        if (n.kind==AudioNodeKind::output && n.id!="audio-output") { error="invalid output node id"; return {}; }
        if (n.kind==AudioNodeKind::morpher && !(n.stepCount==4||n.stepCount==8||n.stepCount==16||n.stepCount==32)) { error="invalid Morpher step count"; return {}; }
    }
    std::vector<int> indegree(spec.nodes.size()); std::vector<std::vector<int>> downstream(spec.nodes.size());
    for (int d=0;d<(int)spec.nodes.size();++d) for (const auto& in:spec.nodes[(size_t)d].inputs) {
        const auto kind=spec.nodes[(size_t)d].kind;
        const bool validPort=(kind==AudioNodeKind::vst||kind==AudioNodeKind::sequencer||kind==AudioNodeKind::output)
            ? in.portId=="audio-in"
            : (kind==AudioNodeKind::mixer||kind==AudioNodeKind::morpher) && in.portId.rfind("audio-in-",0)==0;
        if(!validPort){error="invalid audio input port: "+in.portId;return{};}
        if(in.sourcePortId!="audio-out"){error="invalid audio source port: "+in.sourcePortId;return{};}
        auto found=index.find(in.sourceNodeId); if(found==index.end()){error="unknown audio source: "+in.sourceNodeId;return{};}
        if(spec.nodes[(size_t)found->second].kind==AudioNodeKind::output){error="Audio Output cannot be a source";return{};}
        if(found->second==d){error="audio cycle";return{};} downstream[(size_t)found->second].push_back(d); ++indegree[(size_t)d];
    }
    std::priority_queue<int,std::vector<int>,std::greater<int>> ready;
    for(int i=0;i<(int)indegree.size();++i) if(indegree[(size_t)i]==0) ready.push(i);
    std::vector<int> order; while(!ready.empty()){int i=ready.top();ready.pop();order.push_back(i);for(int d:downstream[(size_t)i])if(--indegree[(size_t)d]==0)ready.push(d);}
    if(order.size()!=spec.nodes.size()){error="audio cycle";return{};}
    auto plan=std::make_unique<AudioExecutionPlan>(); plan->maxBlockSize_=maxBlockSize;plan->sequencer_=sequencer;
    std::unordered_map<int,int> compiled;
    for(int original:order){const auto& s=spec.nodes[(size_t)original];Node n;n.id=s.id;n.kind=s.kind;n.masterLevel=std::clamp(s.masterLevel,0.0f,2.0f);n.stepCount=s.stepCount;n.steps=s.steps;
        if(n.kind==AudioNodeKind::vst)n.chain=chainLookup(n.id);
        if(n.kind==AudioNodeKind::sequencer)n.sequencer=sequencer;
        if(n.kind==AudioNodeKind::mixer||n.kind==AudioNodeKind::morpher)n.signalMeter=std::make_unique<AudioSignalMeter>();
        for(const auto& in:s.inputs){n.sources.push_back(compiled.at(index.at(in.sourceNodeId)));n.levels.push_back(std::clamp(in.level,0.0f,2.0f));n.mutes.push_back(in.muted);}
        n.output.setSize(2,maxBlockSize,false,true,false);n.output.clear();n.sequencerInput.setSize(2,maxBlockSize,false,true,false);n.sequencerInput.clear();compiled[original]=(int)plan->nodes_.size();plan->nodes_.push_back(std::move(n));}
    return plan;
}

float AudioExecutionPlan::morpherPosition(const Node& n,double ppq,int numerator,int denominator) noexcept
{
    const double bar=double(numerator)*4.0/double(std::max(1,denominator));
    double phase=std::fmod(ppq,bar);if(phase<0)phase+=bar;phase/=bar;
    const double scaled=phase*n.stepCount;const int step=std::min(n.stepCount-1,(int)std::floor(scaled));const float f=(float)(scaled-step);
    const float a=std::clamp(n.steps[(size_t)step],0.0f,1.0f),b=std::clamp(n.steps[(size_t)((step+1)%n.stepCount)],0.0f,1.0f);
    return a+(b-a)*f;
}

float AudioExecutionPlan::mixScalar(const float* values,const float* levels,const bool* mutes,int count,float master) noexcept
{ float sum=0;for(int i=0;i<count;++i)if(!mutes[i])sum+=values[i]*levels[i];return sum*master; }

std::pair<float,float> AudioExecutionPlan::equalPowerGains(float f) noexcept
{ f=std::clamp(f,0.0f,1.0f);return {std::cos(f*juce::MathConstants<float>::halfPi),std::sin(f*juce::MathConstants<float>::halfPi)}; }

void AudioExecutionPlan::process(float* const* hw,int hwChannels,int count,Transport& transport,juce::MidiBuffer& midi,
                                 const juce::AudioBuffer<float>* hardwareInput) noexcept
{
    if(count>maxBlockSize_)return;
    for(auto& n:nodes_){n.output.clear(0,count);
        const bool hasSequencerSource=std::any_of(n.sources.begin(),n.sources.end(),[this](int source){return nodes_[(size_t)source].kind==AudioNodeKind::sequencer;});
        if(hasSequencerSource&&sequencer_){n.sequencerInput.clear(0,count);sequencer_->renderAudioForOutput(n.sequencerInput,count,transport,n.id);}
        const auto& sourceBuffer=[&](int source)->const juce::AudioBuffer<float>&{return nodes_[(size_t)source].kind==AudioNodeKind::sequencer?n.sequencerInput:nodes_[(size_t)source].output;};
        if(n.kind==AudioNodeKind::input){
            if(hardwareInput&&hardwareInput->getNumChannels()>0&&hardwareInput->getNumSamples()>=count)
                for(int ch=0;ch<2;++ch)n.output.copyFrom(ch,0,*hardwareInput,std::min(ch,hardwareInput->getNumChannels()-1),0,count);
        }
        else if(n.kind==AudioNodeKind::vst){for(int source:n.sources)for(int ch=0;ch<2;++ch)n.output.addFrom(ch,0,sourceBuffer(source),ch,0,count);midi.clear();n.chain->processBlock(n.output,midi);}
        else if(n.kind==AudioNodeKind::sequencer){
            // Recording taps exist only at visible, direct AUDIO IN edges.
            // A node elsewhere in the DAG can no longer feed an armed track
            // merely because it happens to be compiled in the same plan.
            if(sequencer_)for(int source:n.sources)sequencer_->captureSource(nodes_[(size_t)source].id,sourceBuffer(source),count,transport);
        }
        else if(n.kind==AudioNodeKind::mixer){for(size_t i=0;i<n.sources.size();++i)if(!n.mutes[i])for(int ch=0;ch<2;++ch)n.output.addFrom(ch,0,sourceBuffer(n.sources[i]),ch,0,count,n.levels[i]*n.masterLevel);if(n.signalMeter){n.signalMeter->observe(n.output,count,AudioSignalBoundary::input);n.signalMeter->observe(n.output,count,AudioSignalBoundary::output);}}
        else if(n.kind==AudioNodeKind::morpher){const size_t total=n.sources.size();if(total==1){for(int ch=0;ch<2;++ch)n.output.copyFrom(ch,0,sourceBuffer(n.sources[0]),ch,0,count);}else if(total>1){const double start=transport.ppqPosition(),delta=transport.processingPlaying()?transport.quarterNotesPerSample():0.0;for(int sample=0;sample<count;++sample){float p=morpherPosition(n,start+delta*sample);float scaled=p*(float)(total-1);size_t left=(size_t)std::floor(scaled),right=std::min(left+1,total-1);float f=scaled-(float)left;auto gains=equalPowerGains(f);for(int ch=0;ch<2;++ch)n.output.setSample(ch,sample,sourceBuffer(n.sources[left]).getSample(ch,sample)*gains.first+(right==left?0.0f:sourceBuffer(n.sources[right]).getSample(ch,sample)*gains.second));}}if(n.signalMeter){n.signalMeter->observe(n.output,count,AudioSignalBoundary::input);n.signalMeter->observe(n.output,count,AudioSignalBoundary::output);}}
        else {
            // Preserve the exact pre-Master Audio Output signal in the node's
            // preallocated buffer. This is both the authoritative final mix
            // tap and a deterministic diagnostic point; no callback-time
            // allocation or copy outside the existing stereo graph occurs.
            for(int source:n.sources)for(int ch=0;ch<2;++ch)
                n.output.addFrom(ch,0,sourceBuffer(source),ch,0,count);
            for(int ch=0;ch<std::min(2,hwChannels);++ch)
                if(hw[ch])juce::FloatVectorOperations::add(hw[ch],n.output.getReadPointer(ch),count);
        }
    }
}
} // namespace mlh
